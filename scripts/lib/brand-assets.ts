export const BRAND_ASSET_PATHS = {
  developmentIconComposerProject: "assets/dev/app-icon.icon",
  developmentIosIconPng: "assets/dev/blueprint-ios-1024.png",
  developmentUniversalIconPng: "assets/dev/blueprint-universal-1024.png",

  productionIconComposerProject: "assets/prod/app-icon.icon",
  productionIosIconPng: "assets/prod/black-ios-1024.png",
  productionMacIconPng: "assets/prod/black-macos-1024.png",
  productionLinuxIconPng: "assets/prod/black-universal-1024.png",
  productionWindowsIconIco: "assets/prod/t3-black-windows.ico",
  productionWebFaviconIco: "assets/prod/t3-black-web-favicon.ico",
  productionWebFavicon16Png: "assets/prod/t3-black-web-favicon-16x16.png",
  productionWebFavicon32Png: "assets/prod/t3-black-web-favicon-32x32.png",
  productionWebAppleTouchIconPng: "assets/prod/t3-black-web-apple-touch-180.png",

  nightlyIconComposerProject: "assets/nightly/app-icon.icon",
  nightlyIosIconPng: "assets/nightly/nightly-ios-1024.png",
  nightlyMacIconPng: "assets/nightly/nightly-macos-1024.png",
  nightlyLinuxIconPng: "assets/nightly/nightly-universal-1024.png",
  nightlyWindowsIconIco: "assets/nightly/nightly-windows.ico",
  nightlyWebFaviconIco: "assets/nightly/nightly-web-favicon.ico",
  nightlyWebFavicon16Png: "assets/nightly/nightly-web-favicon-16x16.png",
  nightlyWebFavicon32Png: "assets/nightly/nightly-web-favicon-32x32.png",
  nightlyWebAppleTouchIconPng: "assets/nightly/nightly-web-apple-touch-180.png",

  developmentDesktopIconPng: "assets/dev/blueprint-macos-1024.png",
  developmentWindowsIconIco: "assets/dev/blueprint-windows.ico",
  developmentWebFaviconIco: "assets/dev/blueprint-web-favicon.ico",
  developmentWebFavicon16Png: "assets/dev/blueprint-web-favicon-16x16.png",
  developmentWebFavicon32Png: "assets/dev/blueprint-web-favicon-32x32.png",
  developmentWebAppleTouchIconPng: "assets/dev/blueprint-web-apple-touch-180.png",

  // d3-code carries its own identity so it installs alongside T3 Code rather
  // than replacing it. Each channel has one Icon Composer project and the rest
  // of its files are generated from it by scripts/export-brand-icons.ts.
  d3DevelopmentIconComposerProject: "assets/d3/dev/app-icon.icon",
  d3DevelopmentIosIconPng: "assets/d3/dev/d3-ios-1024.png",
  d3DevelopmentMacIconPng: "assets/d3/dev/d3-macos-1024.png",
  d3DevelopmentUniversalIconPng: "assets/d3/dev/d3-universal-1024.png",
  d3DevelopmentWindowsIconIco: "assets/d3/dev/d3-windows.ico",
  d3DevelopmentWebFaviconIco: "assets/d3/dev/d3-web-favicon.ico",
  d3DevelopmentWebFavicon16Png: "assets/d3/dev/d3-web-favicon-16x16.png",
  d3DevelopmentWebFavicon32Png: "assets/d3/dev/d3-web-favicon-32x32.png",
  d3DevelopmentWebAppleTouchIconPng: "assets/d3/dev/d3-web-apple-touch-180.png",

  d3NightlyIconComposerProject: "assets/d3/nightly/app-icon.icon",
  d3NightlyIosIconPng: "assets/d3/nightly/d3-ios-1024.png",
  d3NightlyMacIconPng: "assets/d3/nightly/d3-macos-1024.png",
  d3NightlyUniversalIconPng: "assets/d3/nightly/d3-universal-1024.png",
  d3NightlyWindowsIconIco: "assets/d3/nightly/d3-windows.ico",
  d3NightlyWebFaviconIco: "assets/d3/nightly/d3-web-favicon.ico",
  d3NightlyWebFavicon16Png: "assets/d3/nightly/d3-web-favicon-16x16.png",
  d3NightlyWebFavicon32Png: "assets/d3/nightly/d3-web-favicon-32x32.png",
  d3NightlyWebAppleTouchIconPng: "assets/d3/nightly/d3-web-apple-touch-180.png",

  d3ProductionIconComposerProject: "assets/d3/prod/app-icon.icon",
  d3ProductionIosIconPng: "assets/d3/prod/d3-ios-1024.png",
  d3ProductionMacIconPng: "assets/d3/prod/d3-macos-1024.png",
  d3ProductionUniversalIconPng: "assets/d3/prod/d3-universal-1024.png",
  d3ProductionWindowsIconIco: "assets/d3/prod/d3-windows.ico",
  d3ProductionWebFaviconIco: "assets/d3/prod/d3-web-favicon.ico",
  d3ProductionWebFavicon16Png: "assets/d3/prod/d3-web-favicon-16x16.png",
  d3ProductionWebFavicon32Png: "assets/d3/prod/d3-web-favicon-32x32.png",
  d3ProductionWebAppleTouchIconPng: "assets/d3/prod/d3-web-apple-touch-180.png",
} as const;

export type WebAssetBrand = "development" | "nightly" | "production";

export const WEB_ASSET_CHANNELS = ["latest", "nightly"] as const;

export type WebAssetChannel = (typeof WEB_ASSET_CHANNELS)[number];

export function resolveWebAssetBrandForChannel(channel: WebAssetChannel): WebAssetBrand {
  return channel === "nightly" ? "nightly" : "production";
}

export function resolveWebAssetBrandForPackageVersion(version: string): WebAssetBrand {
  return version.includes("-nightly.") ? "nightly" : "production";
}

export interface IconOverride {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
}

const WEB_ICON_TARGET_FILENAMES = {
  faviconIco: "favicon.ico",
  favicon16Png: "favicon-16x16.png",
  favicon32Png: "favicon-32x32.png",
  appleTouchIconPng: "apple-touch-icon.png",
} as const;

const WEB_ICON_SOURCE_PATHS_BY_BRAND = {
  development: {
    faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
  },
  nightly: {
    faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
  },
  production: {
    faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.productionWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.productionWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
  },
} as const satisfies Record<WebAssetBrand, Record<keyof typeof WEB_ICON_TARGET_FILENAMES, string>>;

export function resolveWebIconOverrides(
  brand: WebAssetBrand,
  targetDirectory: string,
): ReadonlyArray<IconOverride> {
  const sourcePaths = WEB_ICON_SOURCE_PATHS_BY_BRAND[brand];
  return [
    {
      sourceRelativePath: sourcePaths.faviconIco,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.faviconIco}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon16Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon16Png}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon32Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon32Png}`,
    },
    {
      sourceRelativePath: sourcePaths.appleTouchIconPng,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.appleTouchIconPng}`,
    },
  ];
}

export const DEVELOPMENT_ICON_OVERRIDES = resolveWebIconOverrides("development", "dist/client");

export const DEVELOPMENT_PUBLIC_ICON_OVERRIDES = resolveWebIconOverrides(
  "development",
  "apps/web/public",
);
