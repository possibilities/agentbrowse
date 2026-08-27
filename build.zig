const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const core = b.addModule("kernel_live_view", .{
        .root_source_file = b.path("src/root.zig"),
        .target = target,
    });

    const exe = b.addExecutable(.{
        .name = "kernel-live-view",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{.{ .name = "kernel_live_view", .module = core }},
        }),
    });
    const framework_root = ".deps/LiveKitWebRTC.xcframework/macos-arm64_x86_64";
    const framework = framework_root ++ "/LiveKitWebRTC.framework";
    exe.root_module.addIncludePath(b.path("include"));
    exe.root_module.addFrameworkPath(b.path(framework_root));
    exe.root_module.addCSourceFile(.{
        .file = b.path("platform/macos/native_bridge.mm"),
        .flags = &.{ "-std=c++17", "-fobjc-arc" },
    });
    exe.root_module.link_libc = true;
    exe.root_module.link_libcpp = true;
    exe.root_module.linkFramework("AppKit", .{});
    exe.root_module.linkFramework("Foundation", .{});
    exe.root_module.linkFramework("Metal", .{});
    exe.root_module.linkFramework("MetalKit", .{});
    exe.root_module.linkFramework("LiveKitWebRTC", .{});
    exe.root_module.addRPathSpecial("@executable_path/../Frameworks");
    b.installArtifact(exe);

    const app_name = "Kernel Live View.app";
    const app_executable = app_name ++ "/Contents/MacOS/kernel-live-view";
    const app_framework = app_name ++ "/Contents/Frameworks/LiveKitWebRTC.framework";
    const install_app_executable = b.addInstallArtifact(exe, .{
        .dest_dir = .{ .override = .{ .custom = app_name ++ "/Contents/MacOS" } },
    });
    const install_info = b.addInstallFile(
        b.path("platform/macos/Info.plist"),
        app_name ++ "/Contents/Info.plist",
    );
    const install_notices = b.addInstallFile(
        b.path("THIRD_PARTY_NOTICES.md"),
        app_name ++ "/Contents/Resources/THIRD_PARTY_NOTICES.md",
    );
    const install_license = b.addInstallFile(
        b.path(".deps/LiveKitWebRTC.xcframework/LICENSE"),
        app_name ++ "/Contents/Resources/LiveKitWebRTC-LICENSE.txt",
    );
    const install_framework = b.addSystemCommand(&.{
        "/usr/bin/ditto",
        framework,
        b.getInstallPath(.prefix, "Frameworks/LiveKitWebRTC.framework"),
    });
    const install_app_framework = b.addSystemCommand(&.{
        "/usr/bin/ditto",
        framework,
        b.getInstallPath(.prefix, app_framework),
    });
    const sign_app_framework = b.addSystemCommand(&.{
        "/usr/bin/codesign",
        "--force",
        "--sign",
        "-",
        "--timestamp=none",
        b.getInstallPath(.prefix, app_framework),
    });
    sign_app_framework.step.dependOn(&install_app_framework.step);
    const sign_app = b.addSystemCommand(&.{
        "/usr/bin/codesign",
        "--force",
        "--sign",
        "-",
        "--timestamp=none",
        b.getInstallPath(.prefix, app_name),
    });
    sign_app.step.dependOn(&install_app_executable.step);
    sign_app.step.dependOn(&install_info.step);
    sign_app.step.dependOn(&install_notices.step);
    sign_app.step.dependOn(&install_license.step);
    sign_app.step.dependOn(&sign_app_framework.step);
    b.getInstallStep().dependOn(&install_framework.step);
    b.getInstallStep().dependOn(&install_app_executable.step);
    b.getInstallStep().dependOn(&install_info.step);
    b.getInstallStep().dependOn(&install_notices.step);
    b.getInstallStep().dependOn(&install_license.step);
    b.getInstallStep().dependOn(&install_app_framework.step);
    b.getInstallStep().dependOn(&sign_app.step);

    const run_cmd = b.addSystemCommand(&.{b.getInstallPath(.prefix, app_executable)});
    run_cmd.step.dependOn(b.getInstallStep());
    if (b.args) |args| run_cmd.addArgs(args);
    const run_step = b.step("run", "Run the AppKit Live View client");
    run_step.dependOn(&run_cmd.step);

    const app_step = b.step("app", "Build the self-contained macOS app bundle");
    app_step.dependOn(b.getInstallStep());

    const core_tests = b.addTest(.{ .root_module = core });
    const run_core_tests = b.addRunArtifact(core_tests);
    const test_step = b.step("test", "Run platform-neutral tests");
    test_step.dependOn(&run_core_tests.step);
}
