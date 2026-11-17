#!/usr/bin/env python3
"""Generate Flux's small native Mac project without a third-party project generator."""
import hashlib
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
MAC = ROOT / "mac"
PROJECT = MAC / "Flux.xcodeproj"

# Pinned exactly; the coordinator says when to move (0.4.1 for release, D-117).
SHAREDKIT_URL = "https://github.com/SequoyahGeber/SharedKit.git"
SHAREDKIT_VERSION = "0.4.1"


def identifier(name):
    return hashlib.sha256(name.encode()).hexdigest()[:24].upper()


def generate(build_ui=True):
    # The bundled page is a build product (vite); `--project-only` rewrites only the project files.
    if build_ui:
        subprocess.run(["node", str(ROOT / "scripts/native-desktop.mjs")], cwd=ROOT, check=True)
    objects = []

    def add(name, body):
        objects.append(f"{identifier(name)} = {{ {body} }};")
        return identifier(name)

    sources = sorted((MAC / "Flux").glob("*.swift"))
    # The iPhone's converter screen, its model and its Settings sheet are iPhone-only; the Mac hosts the page (B-19).
    iphone_only = {"LocalView.swift", "LocalModel.swift", "SettingsView.swift"}
    sources += sorted(file for file in (ROOT / "native/App").glob("*.swift") if file.name not in iphone_only)
    source_refs, source_builds = [], []
    for file in sources:
        path = file.name if file.parent == MAC / "Flux" else "../../native/App/" + file.name
        ref = add(file.name, f'isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = "{path}"; sourceTree = "<group>";')
        source_refs.append(ref)
        source_builds.append(add(file.name + "build", f"isa = PBXBuildFile; fileRef = {ref};"))
    resource_refs, resource_builds = [], []
    for file in ["PrivacyInfo.xcprivacy", "Flux.icns"]:
        ref = add(file, f'isa = PBXFileReference; lastKnownFileType = file; path = "{file}"; sourceTree = "<group>";')
        resource_refs.append(ref)
        resource_builds.append(add(file + "build", f"isa = PBXBuildFile; fileRef = {ref};"))
    ref = add("DesktopUI", 'isa = PBXFileReference; lastKnownFileType = folder; path = DesktopUI; sourceTree = "<group>";')
    resource_refs.append(ref)
    resource_builds.append(add("DesktopUIbuild", f"isa = PBXBuildFile; fileRef = {ref};"))
    # The app's name is "Flux"; GENERATE_INFOPLIST_FILE sets CFBundleName to the product name,
    # so the localized InfoPlist.strings carries it (D-023).
    ref = add("en.lproj", 'isa = PBXFileReference; lastKnownFileType = folder; path = en.lproj; sourceTree = "<group>";')
    resource_refs.append(ref)
    resource_builds.append(add("en.lprojbuild", f"isa = PBXBuildFile; fileRef = {ref};"))
    # The app's own words (English; the key is the English text). Xcode extracts SwiftUI literals into it.
    ref = add("Localizable.xcstrings", 'isa = PBXFileReference; lastKnownFileType = text.json.xcstrings; path = "../../native/App/Localizable.xcstrings"; sourceTree = "<group>";')
    resource_refs.append(ref)
    resource_builds.append(add("Localizable.xcstringsbuild", f"isa = PBXBuildFile; fileRef = {ref};"))
    info = add("Info.plist", 'isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>";')
    entitlements = add("Flux.entitlements", 'isa = PBXFileReference; lastKnownFileType = text.plist.entitlements; path = Flux.entitlements; sourceTree = "<group>";')
    product = add("product", 'isa = PBXFileReference; explicitFileType = wrapper.application; path = "Flux File Converter.app"; sourceTree = BUILT_PRODUCTS_DIR;')
    source_group = add("source-group", f'isa = PBXGroup; children = ({", ".join(source_refs + resource_refs + [info, entitlements])}); path = Flux; sourceTree = "<group>";')
    products = add("products", f'isa = PBXGroup; children = ({product}); name = Products; sourceTree = "<group>";')
    main = add("main", f'isa = PBXGroup; children = ({source_group}, {products}); sourceTree = "<group>";')
    source_phase = add("sources", f"isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = ({', '.join(source_builds)}); runOnlyForDeploymentPostprocessing = 0;")
    resources = add("resources", f"isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = ({', '.join(resource_builds)}); runOnlyForDeploymentPostprocessing = 0;")
    package = add("offline-package", 'isa = XCLocalSwiftPackageReference; relativePath = "../native/OfflineKit";')
    dependency = add("offline-product", f'isa = XCSwiftPackageProductDependency; package = {package}; productName = OfflineKit;')
    link = add("offline-link", f'isa = PBXBuildFile; productRef = {dependency};')
    # SharedKit by exact version tag over HTTPS, never a path or a range (SharedKit README, "How an app pins").
    # Written in Xcode's own multi-line layout so SharedKit's marker lint reads the pin.
    shared = identifier("sharedkit-package")
    objects.append(f"{shared} = {{\n\t\t\tisa = XCRemoteSwiftPackageReference;\n\t\t\trepositoryURL = \"{SHAREDKIT_URL}\";\n"
                   f"\t\t\trequirement = {{\n\t\t\t\tkind = exactVersion;\n\t\t\t\tversion = {SHAREDKIT_VERSION};\n\t\t\t}};\n\t\t}};")
    shared_products = [add("sharedkit-" + name, f'isa = XCSwiftPackageProductDependency; package = {shared}; productName = {name};')
                       for name in ("SharedAbout", "SharedDesign", "SharedDiagnostics", "SharedFeedback", "SharedStrings")]
    shared_links = [add("sharedkit-link-" + product, f'isa = PBXBuildFile; productRef = {product};') for product in shared_products]
    product_dependencies = ", ".join([dependency] + shared_products)
    frameworks = add("frameworks", f"isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = ({', '.join([link] + shared_links)}); runOnlyForDeploymentPostprocessing = 0;")
    project_configs, target_configs = [], []
    for mode in ["Debug", "Release"]:
        project_configs.append(add("project" + mode, f'isa = XCBuildConfiguration; name = {mode}; buildSettings = {{ SDKROOT = macosx; MACOSX_DEPLOYMENT_TARGET = 14.0; CLANG_ENABLE_MODULES = YES; SWIFT_VERSION = 5.0; DEBUG_INFORMATION_FORMAT = "dwarf-with-dsym"; ENABLE_USER_SCRIPT_SANDBOXING = YES; }};'))
        target_configs.append(add("target" + mode, f'''isa = XCBuildConfiguration; name = {mode}; buildSettings = {{
            PRODUCT_NAME = "Flux File Converter"; PRODUCT_MODULE_NAME = Flux; PRODUCT_BUNDLE_IDENTIFIER = com.sequoyah.flux.mac;
            DEVELOPMENT_TEAM = 8MLN9FH4F9; CODE_SIGN_STYLE = Manual;
            CODE_SIGN_IDENTITY = "$(FLUX_SIGNING_IDENTITY)"; PROVISIONING_PROFILE_SPECIFIER = "$(FLUX_PROFILE)";
            CODE_SIGN_ENTITLEMENTS = Flux/Flux.entitlements; ENABLE_APP_SANDBOX = YES;
            ENABLE_HARDENED_RUNTIME = YES; GENERATE_INFOPLIST_FILE = YES; SWIFT_EMIT_LOC_STRINGS = YES; LOCALIZATION_PREFERS_STRING_CATALOGS = YES;
            INFOPLIST_FILE = Flux/Info.plist; CURRENT_PROJECT_VERSION = 1;
            MARKETING_VERSION = {(ROOT / "native/VERSION").read_text().strip()}; COMBINE_HIDPI_IMAGES = YES;
            SWIFT_OPTIMIZATION_LEVEL = {"-Onone" if mode == "Debug" else "-O"};
            SWIFT_ACTIVE_COMPILATION_CONDITIONS = {"DEBUG" if mode == "Debug" else '""'};
            SUPPORTED_PLATFORMS = macosx; ARCHS = "$(ARCHS_STANDARD)";
            ONLY_ACTIVE_ARCH = {"YES" if mode == "Debug" else "NO"};
        }};'''))
    project_list = add("project-config-list", f"isa = XCConfigurationList; buildConfigurations = ({', '.join(project_configs)}); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;")
    target_list = add("target-config-list", f"isa = XCConfigurationList; buildConfigurations = ({', '.join(target_configs)}); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;")
    target = add("target", f'''isa = PBXNativeTarget; buildConfigurationList = {target_list};
        buildPhases = ({source_phase}, {frameworks}, {resources}); buildRules = (); dependencies = ();
        packageProductDependencies = ({product_dependencies}); name = Flux; productName = "Flux File Converter"; productReference = {product}; productType = "com.apple.product-type.application";''')
    # Mac UI tests (FX-A-14/B-20, D-086, D-105). Like Mac Control's, the bundle has no host target: it drives a
    # separately built "Flux UITests.app" (scripts/mac-uitest.sh: Debug, its own bundle id, ad-hoc signed and
    # sandboxed), so -uiTesting -resetData never reaches the installed Flux's settings. Never part of a release.
    test_files = sorted((MAC / "FluxMacUITests").glob("*.swift"))
    test_refs = [add("mac-test-" + file.name, f'isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = "{file.name}"; sourceTree = "<group>";')
                 for file in test_files]
    test_builds = [add("mac-test-build-" + file.name, f"isa = PBXBuildFile; fileRef = {ref};") for file, ref in zip(test_files, test_refs)]
    # Tests find controls by the app's central accessibility ids, never by display text.
    test_builds.append(add("mac-test-ids-build", f'isa = PBXBuildFile; fileRef = {identifier("AccessibilityID.swift")};'))
    test_product = add("mac-test-product", 'isa = PBXFileReference; explicitFileType = wrapper.cfbundle; path = FluxMacUITests.xctest; sourceTree = BUILT_PRODUCTS_DIR;')
    test_group = add("mac-test-group", f'isa = PBXGroup; children = ({", ".join(test_refs)}); path = FluxMacUITests; sourceTree = "<group>";')
    objects[:] = [value.replace(f"children = ({product});", f"children = ({product}, {test_product});")
                  .replace(f"children = ({source_group}, {products});", f"children = ({source_group}, {test_group}, {products});") for value in objects]
    test_sources = add("mac-test-sources", f"isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = ({', '.join(test_builds)}); runOnlyForDeploymentPostprocessing = 0;")
    test_products = [add("sharedkit-mac-test-" + name, f'isa = XCSwiftPackageProductDependency; package = {shared}; productName = {name};')
                     for name in ("SharedTestSupport", "SharedStrings")]
    test_links = [add("sharedkit-mac-test-link-" + item, f"isa = PBXBuildFile; productRef = {item};") for item in test_products]
    test_frameworks = add("mac-test-frameworks", f"isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = ({', '.join(test_links)}); runOnlyForDeploymentPostprocessing = 0;")
    test_configs = [add("mac-test-" + mode, f'''isa = XCBuildConfiguration; name = {mode}; buildSettings = {{
        PRODUCT_NAME = FluxMacUITests; PRODUCT_BUNDLE_IDENTIFIER = com.sequoyah.flux.uitests.runner;
        GENERATE_INFOPLIST_FILE = YES; CODE_SIGN_STYLE = Manual; CODE_SIGN_IDENTITY = "-"; DEVELOPMENT_TEAM = "";
        SWIFT_VERSION = 5.0; SDKROOT = macosx; MACOSX_DEPLOYMENT_TARGET = 14.0; SUPPORTED_PLATFORMS = macosx;
        SWIFT_ACTIVE_COMPILATION_CONDITIONS = {"DEBUG" if mode == "Debug" else '""'};
    }};''') for mode in ["Debug", "Release"]]
    test_config_list = add("mac-test-config-list", f"isa = XCConfigurationList; buildConfigurations = ({', '.join(test_configs)}); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug;")
    test_target = add("mac-test-target", f'''isa = PBXNativeTarget; buildConfigurationList = {test_config_list};
        buildPhases = ({test_sources}, {test_frameworks}); buildRules = (); dependencies = ();
        packageProductDependencies = ({", ".join(test_products)}); name = FluxMacUITests; productName = FluxMacUITests; productReference = {test_product}; productType = "com.apple.product-type.bundle.ui-testing";''')
    project = add("project", f'''isa = PBXProject; attributes = {{ LastUpgradeCheck = 2700;
        TargetAttributes = {{ {target} = {{ CreatedOnToolsVersion = 27.0; }}; {test_target} = {{ CreatedOnToolsVersion = 27.0; }}; }}; }};
        buildConfigurationList = {project_list}; compatibilityVersion = "Xcode 14.0";
        developmentRegion = en; hasScannedForEncodings = 0; knownRegions = (en, Base);
        mainGroup = {main}; productRefGroup = {products}; projectDirPath = ""; projectRoot = "";
        packageReferences = ({package}, {shared}); targets = ({target}, {test_target});''')
    PROJECT.mkdir(exist_ok=True)
    (PROJECT / "project.pbxproj").write_text("// !$*UTF8*$!\n{ archiveVersion = 1; classes = {}; objectVersion = 56; objects = {\n" + "\n".join(objects) + f"\n}}; rootObject = {project}; }}\n")
    # Keep the shared icon as the source of truth. It is copied during project generation.
    (MAC / "Flux" / "Flux.icns").write_bytes((ROOT / "resources" / "icon.icns").read_bytes())
    scheme = PROJECT / "xcshareddata" / "xcschemes"
    scheme.mkdir(parents=True, exist_ok=True)
    ref = f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target}" BuildableName="Flux File Converter.app" BlueprintName="Flux" ReferencedContainer="container:Flux.xcodeproj"/>'
    (scheme / "Flux.xcscheme").write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2700" version="1.3">
<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{ref}</BuildActionEntry></BuildActionEntries></BuildAction>
<LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" allowLocationSimulation="NO"><BuildableProductRunnable runnableDebuggingMode="0">{ref}</BuildableProductRunnable></LaunchAction>
<ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">{ref}</BuildableProductRunnable></ProfileAction>
<AnalyzeAction buildConfiguration="Debug"/>
<ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>''')
    # A scheme of its own, so the app's scheme (release scripts, archives) is unchanged.
    test_ref = f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{test_target}" BuildableName="FluxMacUITests.xctest" BlueprintName="FluxMacUITests" ReferencedContainer="container:Flux.xcodeproj"/>'
    (scheme / "FluxMacUITests.xcscheme").write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2700" version="1.3">
<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="NO" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="NO">{test_ref}</BuildActionEntry></BuildActionEntries></BuildAction>
<TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO" parallelizable="NO">{test_ref}</TestableReference></Testables></TestAction>
</Scheme>''')


if __name__ == "__main__":
    import sys
    generate(build_ui="--project-only" not in sys.argv[1:])
    print("Generated mac/Flux.xcodeproj")
