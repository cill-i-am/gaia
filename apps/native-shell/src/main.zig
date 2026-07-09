const std = @import("std");
const build_options = @import("build_options");
const runner = @import("runner");
const native_sdk = @import("native_sdk");

pub const panic = std.debug.FullPanic(native_sdk.debug.capturePanic);

const default_dashboard_url = "http://127.0.0.1:3000/";
const default_server_url = "http://127.0.0.1:8765";

const native_bridge_origins = [_][]const u8{
    "zero://app",
    "zero://inline",
    "http://127.0.0.1:3000",
    "http://localhost:3000",
};

const bridge_policies = [_]native_sdk.BridgeCommandPolicy{
    .{ .name = "gaia.native.status", .origins = &native_bridge_origins },
};

const bridge_handlers = [_]native_sdk.BridgeHandler{
    .{ .name = "gaia.native.status", .context = undefined, .invoke_fn = nativeStatus },
};

const native_commands = [_][]const u8{
    "gaia.focus-dashboard",
    "gaia.show-native-status",
};

const builtin_bridge_policies = [_]native_sdk.BridgeCommandPolicy{
    .{
        .name = "native-sdk.command.invoke",
        .permissions = &.{native_sdk.security.permission_command},
        .origins = &native_bridge_origins,
    },
    .{
        .name = "native-sdk.command.list",
        .permissions = &.{native_sdk.security.permission_command},
        .origins = &native_bridge_origins,
    },
    .{
        .name = "native-sdk.platform.supports",
        .permissions = &.{native_sdk.security.permission_window},
        .origins = &native_bridge_origins,
    },
};

const App = struct {
    env_map: *std.process.Environ.Map,
    dashboard_url: []const u8 = default_dashboard_url,
    server_url: []const u8 = default_server_url,
    allowed_origins: [6][]const u8 = undefined,
    bridge_handlers: [bridge_handlers.len]native_sdk.BridgeHandler = bridge_handlers,
    last_command: LastCommand = .{},

    fn app(self: *@This()) native_sdk.App {
        for (&self.bridge_handlers) |*handler| handler.context = self;
        return .{
            .context = self,
            .name = "gaia-native-shell",
            .source = native_sdk.frontend.productionSource(.{ .dist = "dist" }),
            .source_fn = source,
            .event_fn = event,
        };
    }

    fn bridge(self: *@This()) native_sdk.BridgeDispatcher {
        for (&self.bridge_handlers) |*handler| handler.context = self;
        return .{
            .policy = .{ .enabled = true, .commands = &bridge_policies },
            .registry = .{ .handlers = &self.bridge_handlers },
        };
    }

    fn source(context: *anyopaque) anyerror!native_sdk.WebViewSource {
        const self: *@This() = @ptrCast(@alignCast(context));
        return native_sdk.frontend.sourceFromEnv(self.env_map, .{
            .dist = "dist",
            .entry = "index.html",
        });
    }

    fn security(self: *@This()) native_sdk.SecurityPolicy {
        self.allowed_origins = .{
            "zero://app",
            "zero://inline",
            "http://127.0.0.1:3000",
            "http://localhost:3000",
            originFromUrl(self.dashboard_url),
            originFromUrl(self.server_url),
        };
        return .{
            .permissions = &.{ native_sdk.security.permission_command, native_sdk.security.permission_window, native_sdk.security.permission_dialog },
            .navigation = .{ .allowed_origins = &self.allowed_origins },
        };
    }

    fn event(context: *anyopaque, runtime: *native_sdk.Runtime, event_value: native_sdk.Event) anyerror!void {
        const self: *@This() = @ptrCast(@alignCast(context));
        switch (event_value) {
            .command => |command| try self.handleCommand(runtime, command),
            else => {},
        }
    }

    fn handleCommand(self: *@This(), runtime: *native_sdk.Runtime, command: native_sdk.CommandEvent) !void {
        if (!isNativeCommand(command.name)) return error.InvalidCommand;
        self.last_command.record(command.name, @tagName(command.source), command.window_id);

        if (std.mem.eql(u8, command.name, "gaia.focus-dashboard")) {
            runtime.focusWindow(if (command.window_id == 0) 1 else command.window_id) catch |err| {
                self.last_command.unavailable = @errorName(err);
            };
        } else if (std.mem.eql(u8, command.name, "gaia.show-native-status")) {
            var message_buffer: [384]u8 = undefined;
            const message = std.fmt.bufPrint(&message_buffer, "Bridge: default-deny\nGaia data over bridge: no\nPlatform: {s}\nWeb engine: {s}", .{
                build_options.platform,
                build_options.web_engine,
            }) catch "Native status is unavailable.";
            _ = runtime.showMessageDialog(.{
                .style = .info,
                .title = "Gaia Native Status",
                .message = message,
                .informative_text = "Dashboard data still flows through LocalGaiaServerApi, not the native bridge.",
                .primary_button = "OK",
            }) catch |err| {
                self.last_command.unavailable = @errorName(err);
            };
        }
    }
};

const LastCommand = struct {
    name_buffer: [64]u8 = undefined,
    name_len: usize = 0,
    source_buffer: [24]u8 = undefined,
    source_len: usize = 0,
    window_id: native_sdk.WindowId = 0,
    unavailable: []const u8 = "",

    fn record(self: *@This(), command_name: []const u8, command_source: []const u8, window_id: native_sdk.WindowId) void {
        self.name_len = copyBounded(&self.name_buffer, command_name);
        self.source_len = copyBounded(&self.source_buffer, command_source);
        self.window_id = window_id;
        self.unavailable = "";
    }

    fn name(self: *const @This()) []const u8 {
        return self.name_buffer[0..self.name_len];
    }

    fn source(self: *const @This()) []const u8 {
        return self.source_buffer[0..self.source_len];
    }
};

const ConnectionState = enum { online, unavailable };

pub fn main(init: std.process.Init) !void {
    var app = App{
        .env_map = init.environ_map,
        .dashboard_url = envOrDefault(init.environ_map, "NATIVE_SDK_FRONTEND_URL", default_dashboard_url),
        .server_url = envOrDefault(init.environ_map, "GAIA_NATIVE_SERVER_URL", envOrDefault(init.environ_map, "VITE_GAIA_SERVER_URL", default_server_url)),
    };
    const status = checkLocalServer(app.server_url, init.io);
    var title_buffer: [native_sdk.platform.max_window_title_bytes]u8 = undefined;
    const window_title = windowTitleForStatus(status, &title_buffer);

    try runner.runWithOptions(app.app(), .{
        .app_name = "Gaia Native Shell",
        .window_title = window_title,
        .bundle_id = "dev.gaia.native-shell",
        .icon_path = "assets/icon.png",
        .bridge = app.bridge(),
        .builtin_bridge = .{
            .enabled = true,
            .permissions = &.{ native_sdk.security.permission_command, native_sdk.security.permission_window },
            .commands = &builtin_bridge_policies,
        },
        .security = app.security(),
        .js_window_api = true,
        .propagate_dispatch_errors = true,
    }, init);
}

fn envOrDefault(env_map: *std.process.Environ.Map, name: []const u8, default_value: []const u8) []const u8 {
    if (env_map.get(name)) |value| {
        if (value.len > 0) return value;
    }
    return default_value;
}

fn checkLocalServer(server_url: []const u8, io: std.Io) ConnectionState {
    var health_url_buffer: [512]u8 = undefined;
    const health_url = healthUrl(server_url, &health_url_buffer) catch return .unavailable;

    var client: std.http.Client = .{
        .allocator = std.heap.page_allocator,
        .io = io,
    };
    defer client.deinit();

    const result = client.fetch(.{
        .location = .{ .url = health_url },
        .keep_alive = false,
    }) catch return .unavailable;

    if (result.status == .ok) {
        return .online;
    }
    return .unavailable;
}

fn windowTitleForStatus(state: ConnectionState, output: []u8) []const u8 {
    const state_text = switch (state) {
        .online => "online",
        .unavailable => "unavailable",
    };
    return std.fmt.bufPrint(output, "Gaia Native Shell - Local API {s}", .{state_text}) catch "Gaia Native Shell";
}

fn healthUrl(server_url: []const u8, output: []u8) ![]const u8 {
    const trimmed = std.mem.trimEnd(u8, server_url, "/");
    if (trimmed.len == 0) return error.EmptyServerUrl;
    return std.fmt.bufPrint(output, "{s}/health", .{trimmed});
}

fn originFromUrl(url: []const u8) []const u8 {
    const without_trailing_slash = std.mem.trimEnd(u8, url, "/");
    const separator_index = std.mem.indexOf(u8, without_trailing_slash, "://") orelse return without_trailing_slash;
    const authority_start = separator_index + 3;
    const authority = without_trailing_slash[authority_start..];
    const path_index = std.mem.indexOfScalar(u8, authority, '/') orelse return without_trailing_slash;
    return without_trailing_slash[0 .. authority_start + path_index];
}

fn nativeStatus(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    if (!std.mem.eql(u8, invocation.request.payload, "{}")) return error.InvalidCommand;
    const self: *App = @ptrCast(@alignCast(context));
    return writeNativeStatus(output, self.last_command);
}

fn isNativeCommand(command_name: []const u8) bool {
    for (native_commands) |native_command| {
        if (std.mem.eql(u8, command_name, native_command)) return true;
    }
    return false;
}

fn writeNativeStatus(output: []u8, last_command: LastCommand) ![]const u8 {
    var last_command_buffer: [256]u8 = undefined;
    var name_buffer: [96]u8 = undefined;
    var source_buffer: [48]u8 = undefined;
    var unavailable_buffer: [128]u8 = undefined;
    const unavailable_json = if (last_command.unavailable.len == 0)
        "null"
    else
        native_sdk.bridge.writeJsonStringValue(&unavailable_buffer, last_command.unavailable);
    const last_command_json = if (last_command.name_len == 0)
        "null"
    else blk: {
        const name_json = native_sdk.bridge.writeJsonStringValue(&name_buffer, last_command.name());
        const source_json = native_sdk.bridge.writeJsonStringValue(&source_buffer, last_command.source());
        break :blk try std.fmt.bufPrint(&last_command_buffer, "{{\"name\":{s},\"source\":{s},\"windowId\":{d},\"unavailable\":{s}}}", .{
            name_json,
            source_json,
            last_command.window_id,
            unavailable_json,
        });
    };

    return std.fmt.bufPrint(output, "{{\"app\":\"gaia-native-shell\",\"bridge\":\"default-deny\",\"platform\":\"{s}\",\"webEngine\":\"{s}\",\"gaiaDataOverBridge\":false,\"nativeCommands\":[\"gaia.focus-dashboard\",\"gaia.show-native-status\"],\"lastCommand\":{s}}}", .{
        build_options.platform,
        build_options.web_engine,
        last_command_json,
    });
}

fn copyBounded(destination: []u8, source: []const u8) usize {
    const len = @min(destination.len, source.len);
    @memcpy(destination[0..len], source[0..len]);
    return len;
}

test "production source uses the local shell asset directory" {
    const source = native_sdk.frontend.productionSource(.{ .dist = "dist" });
    try std.testing.expectEqual(native_sdk.WebViewSourceKind.assets, source.kind);
    try std.testing.expectEqualStrings("dist", source.asset_options.?.root_path);
}

test "navigation policy includes configured local dashboard and server origins" {
    var env = std.process.Environ.Map.init(std.testing.allocator);
    defer env.deinit();
    var app = App{
        .env_map = &env,
        .dashboard_url = "http://127.0.0.1:3100/dashboard",
        .server_url = "http://127.0.0.1:9876",
    };

    const policy = app.security();

    try std.testing.expect(hasAllowedOrigin(policy.navigation.allowed_origins, "http://127.0.0.1:3100"));
    try std.testing.expect(hasAllowedOrigin(policy.navigation.allowed_origins, "http://127.0.0.1:9876"));
    try std.testing.expect(!hasAllowedOrigin(policy.navigation.allowed_origins, "http://127.0.0.1:4321"));
}

test "health URL is explicit and points at the public server health route" {
    var buffer: [128]u8 = undefined;
    try std.testing.expectEqualStrings(
        "http://127.0.0.1:8765/health",
        try healthUrl("http://127.0.0.1:8765/", &buffer),
    );
}

test "native window title exposes local API connection state" {
    var buffer: [native_sdk.platform.max_window_title_bytes]u8 = undefined;
    try std.testing.expectEqualStrings(
        "Gaia Native Shell - Local API online",
        windowTitleForStatus(.online, &buffer),
    );
    try std.testing.expectEqualStrings(
        "Gaia Native Shell - Local API unavailable",
        windowTitleForStatus(.unavailable, &buffer),
    );
}

test "native bridge policy is exact-origin default deny" {
    const policy: native_sdk.BridgePolicy = .{ .enabled = true, .commands = &bridge_policies };
    try std.testing.expect(policy.allows("gaia.native.status", "zero://app"));
    try std.testing.expect(policy.allows("gaia.native.status", "http://127.0.0.1:3000"));
    try std.testing.expect(!policy.allows("gaia.native.status", "https://example.invalid"));
    try std.testing.expect(!policy.allows("gaia.unknown", "zero://app"));
}

test "native status stays small and excludes Gaia run data" {
    var buffer: [1024]u8 = undefined;
    var last_command = LastCommand{};
    last_command.record("gaia.focus-dashboard", "menu", 1);
    last_command.unavailable = "UnsupportedService";
    const result = try writeNativeStatus(&buffer, last_command);
    try std.testing.expect(result.len < 512);
    try std.testing.expect(std.mem.indexOf(u8, result, "\"gaiaDataOverBridge\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, result, "\"unavailable\":\"UnsupportedService\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, result, ".gaia") == null);
    try std.testing.expect(std.mem.indexOf(u8, result, "events.jsonl") == null);
}

test "built-in bridge policy allows only command and platform support helpers" {
    var policy: native_sdk.BridgePolicy = .{
        .enabled = true,
        .permissions = &.{ native_sdk.security.permission_command, native_sdk.security.permission_window },
        .commands = &builtin_bridge_policies,
    };
    try std.testing.expect(policy.allows("native-sdk.command.invoke", "zero://app"));
    try std.testing.expect(policy.allows("native-sdk.command.list", "http://localhost:3000"));
    try std.testing.expect(policy.allows("native-sdk.platform.supports", "zero://inline"));
    try std.testing.expect(!policy.allows("native-sdk.os.revealPath", "zero://app"));
    try std.testing.expect(!policy.allows("native-sdk.dialog.showMessage", "zero://app"));
    try std.testing.expect(!policy.allows("native-sdk.clipboard.readText", "zero://app"));
    try std.testing.expect(!policy.allows("native-sdk.command.invoke", "https://example.invalid"));
}

test "command bridge rejects unknown Gaia command payloads before recording them" {
    var env_map = std.process.Environ.Map.init(std.testing.allocator);
    defer env_map.deinit();
    var app = App{ .env_map = &env_map };
    const commands = [_]native_sdk.Command{
        .{ .id = "gaia.focus-dashboard", .title = "Focus Dashboard" },
        .{ .id = "gaia.show-native-status", .title = "Show Native Status" },
    };
    const command_permissions = [_][]const u8{
        native_sdk.security.permission_command,
        native_sdk.security.permission_window,
    };
    const origins = [_][]const u8{"zero://inline"};
    const harness = try native_sdk.TestHarness().create(std.testing.allocator, .{});
    defer harness.destroy(std.testing.allocator);
    harness.runtime.options.bridge = app.bridge();
    harness.runtime.options.js_window_api = true;
    harness.runtime.options.commands = &commands;
    harness.runtime.options.security.permissions = &command_permissions;
    harness.runtime.options.security.navigation.allowed_origins = &origins;
    try harness.start(app.app());

    try harness.runtime.dispatchPlatformEvent(app.app(), .{ .bridge_message = .{
        .bytes = "{\"id\":\"known\",\"command\":\"native-sdk.command.invoke\",\"payload\":{\"name\":\"gaia.focus-dashboard\"}}",
        .origin = "zero://inline",
        .window_id = 1,
        .webview_label = "main",
    } });
    try std.testing.expect(std.mem.indexOf(u8, harness.null_platform.lastBridgeResponse(), "\"ok\":true") != null);
    try std.testing.expectEqualStrings("gaia.focus-dashboard", app.last_command.name());

    try harness.runtime.dispatchPlatformEvent(app.app(), .{ .bridge_message = .{
        .bytes = "{\"id\":\"unknown\",\"command\":\"native-sdk.command.invoke\",\"payload\":{\"name\":\"gaia.unknown\"}}",
        .origin = "zero://inline",
        .window_id = 1,
        .webview_label = "main",
    } });

    const response = harness.null_platform.lastBridgeResponse();
    try std.testing.expect(std.mem.indexOf(u8, response, "\"ok\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, response, "\"invalid_request\"") != null);
    try std.testing.expectEqualStrings("gaia.focus-dashboard", app.last_command.name());

    try harness.runtime.dispatchPlatformEvent(app.app(), .{ .bridge_message = .{
        .bytes = "{\"id\":\"status\",\"command\":\"gaia.native.status\",\"payload\":{}}",
        .origin = "zero://inline",
        .window_id = 1,
        .webview_label = "main",
    } });
    const status_response = harness.null_platform.lastBridgeResponse();
    try std.testing.expect(std.mem.indexOf(u8, status_response, "\"gaia.focus-dashboard\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, status_response, "gaia.unknown") == null);
}

test "native status rejects unexpected bridge payloads" {
    var env_map = std.process.Environ.Map.init(std.testing.allocator);
    defer env_map.deinit();
    var app = App{ .env_map = &env_map };
    var output: [512]u8 = undefined;

    const valid = try nativeStatus(&app, .{
        .request = .{ .id = "valid", .command = "gaia.native.status", .payload = "{}" },
        .source = .{},
    }, &output);
    try std.testing.expect(std.mem.indexOf(u8, valid, "\"gaiaDataOverBridge\":false") != null);
    try std.testing.expectError(error.InvalidCommand, nativeStatus(&app, .{
        .request = .{ .id = "invalid", .command = "gaia.native.status", .payload = "{\"includeRuns\":true}" },
        .source = .{},
    }, &output));
}
fn hasAllowedOrigin(origins: []const []const u8, origin: []const u8) bool {
    for (origins) |allowed| {
        if (std.mem.eql(u8, allowed, origin)) return true;
    }
    return false;
}
