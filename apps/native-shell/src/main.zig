const std = @import("std");
const runner = @import("runner");
const native_sdk = @import("native_sdk");

pub const panic = std.debug.FullPanic(native_sdk.debug.capturePanic);

const App = struct {
    env_map: *std.process.Environ.Map,

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
};

const dev_origins = [_][]const u8{
    "zero://app",
    "zero://inline",
    "http://127.0.0.1:3000",
    "http://localhost:3000",
    "http://127.0.0.1:8765",
};

pub fn main(init: std.process.Init) !void {
    var app = App{ .env_map = init.environ_map };
    try runner.runWithOptions(app.app(), .{
        .app_name = "Gaia Native Shell",
        .window_title = "Gaia Native Shell",
        .bundle_id = "dev.gaia.native-shell",
        .icon_path = "assets/icon.png",
        .security = .{
            .navigation = .{ .allowed_origins = &dev_origins },
        },
    }, init);
}

test "production source uses the local shell asset directory" {
    const source = native_sdk.frontend.productionSource(.{ .dist = "dist" });
    try std.testing.expectEqual(native_sdk.WebViewSourceKind.assets, source.kind);
    try std.testing.expectEqualStrings("dist", source.asset_options.?.root_path);
}
