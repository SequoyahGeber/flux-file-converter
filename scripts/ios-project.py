#!/usr/bin/env python3
"""Generate Flux's small native iPhone project without a third-party project generator."""
import hashlib
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
MAC = ROOT / "ios"
PROJECT = MAC / "Flux.xcodeproj"


def identifier(name):
    return hashlib.sha256(name.encode()).hexdigest()[:24].upper()


def generate():
    objects = []

    def add(name, body):
        objects.append(f"{identifier(name)} = {{ {body} }};")
        return identifier(name)

    sources = sorted((MAC / "Flux").glob("*.swift"))
    sources += sorted((ROOT / "native/App").glob("*.swift"))
    source_refs, source_builds = [], []
    for file in sources:
        source_path = file.name if file.parent == MAC / "Flux" else "../../native/App/" + file.name
        ref = add(file.name, f'isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = "{source_path}"; sourceTree = "<group>";')
        source_refs.append(ref)
        source_builds.append(add(file.name + "build", f"isa = PBXBuildFile; fileRef = {ref};"))
    resource_refs, resource_builds = [], []
    for file in ["../../mac/Flux/PrivacyInfo.xcprivacy", "Assets.xcassets"]:
        ref = add(file, f'isa = PBXFileReference; lastKnownFileType = {"folder.assetcatalog" if file == "Assets.xcassets" else "file"}; path = "{file}"; sourceTree = "<group>";')
        resource_refs.append(ref)
        resource_builds.append(add(file + "build", f"isa = PBXBuildFile; fileRef = {ref};"))
    info = add("Info.plist", 'isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>";')
    entitlements = add("Flux.entitlements", 'isa = PBXFileReference; lastKnownFileType = text.plist.entitlements; path = Flux.entitlements; sourceTree = "<group>";')
    product = add("product", 'isa = PBXFileReference; explicitFileType = wrapper.application; path = Flux.app; sourceTree = BUILT_PRODUCTS_DIR;')
    source_group = add("source-group", f'isa = PBXGroup; children = ({", ".join(source_refs + resource_refs + [info, entitlements])}); path = Flux; sourceTree = "<group>";')
    products = add("products", f'isa = PBXGroup; children = ({product}); name = Products; sourceTree = "<group>";')
    main = add("main", f'isa = PBXGroup; children = ({source_group}, {products}); sourceTree = "<group>";')
    source_phase = add("sources", f"isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = ({', '.join(source_builds)}); runOnlyForDeploymentPostprocessing = 0;")
    resources = add("resources", f"isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = ({', '.join(resource_builds)}); runOnlyForDeploymentPostprocessing = 0;")
    package = add("offline-package", 'isa = XCLocalSwiftPackageReference; relativePath = "../native/OfflineKit";')
    dependency = add("offline-product", f'isa = XCSwiftPackageProductDependency; package = {package}; productName = OfflineKit;')
    link = add("offline-link", f'isa = PBXBuildFile; productRef = {dependency};')
    frameworks = add("frameworks", f"isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = ({link}); runOnlyForDeploymentPostprocessing = 0;")
    project_configs, target_configs = [], []
    for mode in ["Debug", "Release"]:
        project_configs.append(add("project" + mode, f'isa = XCBuildConfiguration; name = {mode}; buildSettings = {{ SDKROOT = iphoneos; IPHONEOS_DEPLOYMENT_TARGET = 18.4; CLANG_ENABLE_MODULES = YES; SWIFT_VERSION = 5.0; DEBUG_INFORMATION_FORMAT = "dwarf-with-dsym"; ENABLE_USER_SCRIPT_SANDBOXING = YES; }};'))
        target_configs.append(add("target" + mode, f'''isa = XCBuildConfiguration; name = {mode}; buildSettings = {{
            PRODUCT_NAME = Flux; PRODUCT_BUNDLE_IDENTIFIER = com.sequoyah.flux.mac;
            DEVELOPMENT_TEAM = 8MLN9FH4F9; CODE_SIGN_STYLE = Manual;
            CODE_SIGN_IDENTITY = "$(FLUX_SIGNING_IDENTITY)"; PROVISIONING_PROFILE_SPECIFIER = "$(FLUX_PROFILE)";
            CODE_SIGN_ENTITLEMENTS = Flux/Flux.entitlements; TARGETED_DEVICE_FAMILY = 1;
            ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;
            ENABLE_HARDENED_RUNTIME = NO; GENERATE_INFOPLIST_FILE = YES;
            INFOPLIST_FILE = Flux/Info.plist; CURRENT_PROJECT_VERSION = 1;
            MARKETING_VERSION = 1.0.2; COMBINE_HIDPI_IMAGES = YES;
            SWIFT_OPTIMIZATION_LEVEL = {"-Onone" if mode == "Debug" else "-O"};
            SWIFT_ACTIVE_COMPILATION_CONDITIONS = {"DEBUG" if mode == "Debug" else '""'};
            SUPPORTED_PLATFORMS = "iphoneos iphonesimulator"; SUPPORTS_MACCATALYST = NO; ARCHS = "$(ARCHS_STANDARD)";
            ONLY_ACTIVE_ARCH = {"YES" if mode == "Debug" else "NO"};
        }};'''))
    project_list = add("project-config-list", f"isa = XCConfigurationList; buildConfigurations = ({', '.join(project_configs)}); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;")
    target_list = add("target-config-list", f"isa = XCConfigurationList; buildConfigurations = ({', '.join(target_configs)}); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;")
    target = add("target", f'''isa = PBXNativeTarget; buildConfigurationList = {target_list};
        buildPhases = ({source_phase}, {frameworks}, {resources}); buildRules = (); dependencies = ();
        packageProductDependencies = ({dependency}); name = Flux; productName = Flux; productReference = {product}; productType = "com.apple.product-type.application";''')
    project = add("project", f'''isa = PBXProject; attributes = {{ LastUpgradeCheck = 2700;
        TargetAttributes = {{ {target} = {{ CreatedOnToolsVersion = 27.0; }}; }}; }};
        buildConfigurationList = {project_list}; compatibilityVersion = "Xcode 14.0";
        developmentRegion = en; hasScannedForEncodings = 0; knownRegions = (en, Base);
        mainGroup = {main}; productRefGroup = {products}; projectDirPath = ""; projectRoot = "";
        packageReferences = ({package}); targets = ({target});''')
    PROJECT.mkdir(exist_ok=True)
    (PROJECT / "project.pbxproj").write_text("// !$*UTF8*$!\n{ archiveVersion = 1; classes = {}; objectVersion = 56; objects = {\n" + "\n".join(objects) + f"\n}}; rootObject = {project}; }}\n")
    scheme = PROJECT / "xcshareddata" / "xcschemes"
    scheme.mkdir(parents=True, exist_ok=True)
    ref = f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target}" BuildableName="Flux.app" BlueprintName="Flux" ReferencedContainer="container:Flux.xcodeproj"/>'
    (scheme / "Flux.xcscheme").write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2700" version="1.3">
<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{ref}</BuildActionEntry></BuildActionEntries></BuildAction>
<LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" allowLocationSimulation="NO"><BuildableProductRunnable runnableDebuggingMode="0">{ref}</BuildableProductRunnable></LaunchAction>
<ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">{ref}</BuildableProductRunnable></ProfileAction>
<AnalyzeAction buildConfiguration="Debug"/>
<ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>''')


if __name__ == "__main__":
    generate()
    print("Generated ios/Flux.xcodeproj")
