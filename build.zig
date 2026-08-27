const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = buildTarget(b);
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
    const native_bridge_flags: []const []const u8 = if (b.sysroot) |sysroot| &.{
        "-std=c++17",
        "-fobjc-arc",
        "-fvisibility=hidden",
        "-isysroot",
        sysroot,
        b.fmt("-isystem{s}/usr/include", .{sysroot}),
    } else &.{
        "-std=c++17",
        "-fobjc-arc",
        "-fvisibility=hidden",
    };
    exe.root_module.addIncludePath(b.path("include"));
    exe.root_module.addFrameworkPath(b.path(framework_root));
    if (b.sysroot) |sysroot| {
        exe.root_module.addFrameworkPath(.{
            .cwd_relative = b.pathJoin(&.{ sysroot, "System/Library/Frameworks" }),
        });
    }
    exe.root_module.addCSourceFile(.{
        .file = b.path("platform/macos/native_bridge.mm"),
        .flags = native_bridge_flags,
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

    // Zig 0.16 does not expose Darwin's exported-symbols-list option through
    // std.Build, and its direct dylib link publishes bundled runtime symbols.
    // Build the Zig half as an archive, then let Apple clang link the exact ABI.
    const live_view_archive = b.addLibrary(.{
        .name = "agentbrowse-live-view-core",
        .linkage = .static,
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/live_view_abi.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{.{ .name = "kernel_live_view", .module = core }},
        }),
    });
    live_view_archive.root_module.link_libc = true;
    live_view_archive.bundle_compiler_rt = true;

    const macos_arch = switch (target.result.cpu.arch) {
        .aarch64 => "arm64",
        .x86_64 => "x86_64",
        else => @panic("LiveKitWebRTC supports only arm64 and x86_64 macOS targets"),
    };
    const compile_live_view_bridge = b.addSystemCommand(&.{
        "/usr/bin/xcrun",
        "--sdk",
        "macosx",
        "clang++",
        "-std=c++17",
        "-fobjc-arc",
        "-fvisibility=hidden",
        "-fPIC",
        "-arch",
        macos_arch,
        "-mmacosx-version-min=11.0",
    });
    if (b.sysroot) |sysroot| {
        compile_live_view_bridge.addArgs(&.{ "-isysroot", sysroot });
    }
    compile_live_view_bridge.addPrefixedDirectoryArg("-I", b.path("include"));
    compile_live_view_bridge.addPrefixedDirectoryArg("-F", b.path(framework_root));
    compile_live_view_bridge.addArg("-c");
    compile_live_view_bridge.addFileArg(b.path("platform/macos/native_bridge.mm"));
    compile_live_view_bridge.addArg("-o");
    const live_view_bridge = compile_live_view_bridge.addOutputFileArg(
        "agentbrowse-live-view-native.o",
    );

    // Apple ld requires 8-byte-aligned archive members; ranlib normalizes the
    // compiler_rt member emitted by Zig before the native link consumes it.
    const normalize_live_view_archive = b.addSystemCommand(&.{
        "/bin/sh",
        "-c",
        "/bin/cp \"$1\" \"$2\" && /usr/bin/ranlib \"$2\"",
        "_",
    });
    normalize_live_view_archive.addArtifactArg(live_view_archive);
    const normalized_live_view_archive = normalize_live_view_archive.addOutputFileArg(
        "libagentbrowse-live-view-core.a",
    );

    const link_live_view_lib = b.addSystemCommand(&.{
        "/usr/bin/xcrun",
        "--sdk",
        "macosx",
        "clang++",
        "-dynamiclib",
        "-arch",
        macos_arch,
        "-mmacosx-version-min=11.0",
        "-Wl,-all_load",
        "-Wl,-dead_strip",
        "-Wl,-install_name,@rpath/libagentbrowse-live-view.dylib",
        "-Wl,-rpath,@loader_path/../Frameworks",
        "-Wl,-compatibility_version,1.0.0",
        "-Wl,-current_version,1.0.0",
    });
    if (b.sysroot) |sysroot| {
        link_live_view_lib.addArgs(&.{ "-isysroot", sysroot });
    }
    link_live_view_lib.addPrefixedFileArg(
        "-Wl,-exported_symbols_list,",
        b.path("platform/macos/live_view.exports"),
    );
    link_live_view_lib.addFileArg(normalized_live_view_archive);
    link_live_view_lib.addFileArg(live_view_bridge);
    link_live_view_lib.addPrefixedDirectoryArg("-F", b.path(framework_root));
    link_live_view_lib.addArgs(&.{
        "-framework",
        "AppKit",
        "-framework",
        "CoreFoundation",
        "-framework",
        "Foundation",
        "-framework",
        "Metal",
        "-framework",
        "MetalKit",
        "-framework",
        "LiveKitWebRTC",
        "-lobjc",
        "-o",
    });
    const live_view_lib = link_live_view_lib.addOutputFileArg(
        "libagentbrowse-live-view.dylib",
    );
    const install_live_view_lib = b.addInstallFile(
        live_view_lib,
        "lib/libagentbrowse-live-view.dylib",
    );
    const install_live_view_header = b.addInstallFile(
        b.path("include/agentbrowse_live_view.h"),
        "include/agentbrowse_live_view.h",
    );
    const sign_live_view_lib = b.addSystemCommand(&.{
        "/usr/bin/codesign",
        "--force",
        "--sign",
        "-",
        "--timestamp=none",
        b.getInstallPath(.lib, "libagentbrowse-live-view.dylib"),
    });
    sign_live_view_lib.step.dependOn(&install_live_view_lib.step);
    b.getInstallStep().dependOn(&install_live_view_lib.step);
    b.getInstallStep().dependOn(&install_live_view_header.step);
    b.getInstallStep().dependOn(&sign_live_view_lib.step);

    const live_view_lib_step = b.step(
        "live-view-lib",
        "Build the headless Live View dynamic library and public header",
    );
    live_view_lib_step.dependOn(&install_live_view_lib.step);
    live_view_lib_step.dependOn(&install_live_view_header.step);
    live_view_lib_step.dependOn(&sign_live_view_lib.step);

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
    live_view_lib_step.dependOn(&install_framework.step);
    const sign_framework = b.addSystemCommand(&.{
        "/usr/bin/codesign",
        "--force",
        "--sign",
        "-",
        "--timestamp=none",
        b.getInstallPath(.prefix, "Frameworks/LiveKitWebRTC.framework"),
    });
    sign_framework.step.dependOn(&install_framework.step);
    live_view_lib_step.dependOn(&sign_framework.step);
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
    b.getInstallStep().dependOn(&sign_framework.step);
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

fn buildTarget(b: *std.Build) std.Build.ResolvedTarget {
    const target = b.standardTargetOptions(.{});
    if (target.result.os.tag != .macos) return target;
    if (b.sysroot == null) b.sysroot = macosSdkPath(b) orelse b.sysroot;
    var query = target.query;
    query.os_tag = .macos;
    query.os_version_min = .{ .semver = .{ .major = 11, .minor = 0, .patch = 0 } };
    return b.resolveTargetQuery(query);
}

fn macosSdkPath(b: *std.Build) ?[]const u8 {
    if (b.graph.environ_map.get("SDKROOT")) |sdkroot| {
        if (sdkroot.len > 0) return sdkroot;
    }
    const sdk = std.process.run(b.allocator, b.graph.io, .{
        .argv = &.{ "xcrun", "--sdk", "macosx", "--show-sdk-path" },
        .stdout_limit = .limited(4096),
        .stderr_limit = .limited(4096),
    }) catch return null;
    defer b.allocator.free(sdk.stderr);
    if (sdk.term != .exited or sdk.term.exited != 0) {
        b.allocator.free(sdk.stdout);
        return null;
    }
    return std.mem.trimEnd(u8, sdk.stdout, "\r\n");
}
