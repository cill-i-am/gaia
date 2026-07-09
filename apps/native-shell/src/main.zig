const std = @import("std");
const runner = @import("runner");
const native_sdk = @import("native_sdk");

pub const panic = std.debug.FullPanic(native_sdk.debug.capturePanic);

const default_dashboard_url = "http://127.0.0.1:3000/";
const default_server_url = "http://127.0.0.1:8765";

const App = struct {
    env_map: *std.process.Environ.Map,
    dashboard_url: []const u8,
    server_url: []const u8,
    allowed_origins: [6][]const u8 = undefined,

    fn app(self: *@This()) native_sdk.App {
        return .{
            .context = self,
            .name = "gaia-native-shell",
            .source = native_sdk.frontend.productionSource(.{ .dist = "dist" }),
            .source_fn = source,
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
            .navigation = .{ .allowed_origins = &self.allowed_origins },
        };
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
        .security = app.security(),
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

fn hasAllowedOrigin(origins: []const []const u8, origin: []const u8) bool {
    for (origins) |allowed| {
        if (std.mem.eql(u8, allowed, origin)) return true;
    }
    return false;
}
