import type { ExpoConfig } from "expo/config";

import { loadRepoEnv, readForkVersion } from "../../scripts/lib/public-config.ts";

/**
 * The fork's mobile identity, applied to upstream's finished Expo config.
 *
 * Upstream's app.config.ts is left as upstream writes it and hands its result
 * here as the last thing it does. Everything that makes the app D3-code rather
 * than T3 Code is a rewrite of that result, keyed on the fields upstream already
 * exposes (`extra.appVariant`, `extra.iosPersonalTeamBuild`), so an upstream
 * edit inside app.config.ts merges on its own and the identity still lands.
 */

type AppVariant = "development" | "preview" | "production";

// The channels carry the d3-code identity, so nothing has to be passed at the
// command line to get it. Upstream's own identifiers stay on upstream's branches.
const IDENTITY: Record<AppVariant, { appName: string; scheme: string; bundleIdentifier: string }> =
  {
    development: {
      appName: "D3-code Dev",
      scheme: "d3code-dev",
      bundleIdentifier: "net.xalior.d3code.dev",
    },
    preview: {
      appName: "D3-code Preview",
      scheme: "d3code-preview",
      bundleIdentifier: "net.xalior.d3code.preview",
    },
    production: {
      appName: "D3-code",
      scheme: "d3code",
      bundleIdentifier: "net.xalior.d3code",
    },
  };

// d3-code's own EAS project. Updates are served by the project that owns the
// app, so the updates URL and the project id name the same one. Declaring
// another account's project stops the development server producing a manifest
// at all, with an error that mentions neither.
const EAS_PROJECT_ID = "d1967699-a1db-470b-acfe-6c37e27e17e9";

// Every channel sits on the same black badge, so the notification colour is
// white in all three.
const NOTIFICATION_COLOR = "#FFFFFF";

// Plugins the fork does not ship. The widget and share extensions need app
// groups and their own signed targets, which a local build cannot carry, and
// the fork has no store build that could.
const DROPPED_PLUGINS = new Set([
  "expo-widgets",
  "expo-sharing",
  "./plugins/withShareExtensionDisplayName.cjs",
  "./plugins/withWidgetLogoAsset.cjs",
]);

type Plugin = NonNullable<ExpoConfig["plugins"]>[number];

function pluginName(plugin: Plugin): string {
  return typeof plugin === "string" ? plugin : String(plugin[0]);
}

function rewritePlugin(plugin: Plugin): Plugin {
  const name = pluginName(plugin);
  if (name === "@clerk/expo" && Array.isArray(plugin)) {
    // Sign in with Apple needs an entitlement the local signing profile cannot
    // carry, and the fork has no store build that could.
    return [name, { ...(plugin[1] as Record<string, unknown>), appleSignIn: false }];
  }
  if (name === "expo-notifications" && Array.isArray(plugin)) {
    return [name, { ...(plugin[1] as Record<string, unknown>), color: NOTIFICATION_COLOR }];
  }
  return plugin;
}

export function withD3Identity(config: ExpoConfig): ExpoConfig {
  const repoEnv = loadRepoEnv();
  const variant = (config.extra?.appVariant ?? "production") as AppVariant;
  const identity = IDENTITY[variant];
  const isPersonalTeamBuild = config.extra?.iosPersonalTeamBuild === true;
  // A personal-team build already carries the identifier the developer chose.
  const bundleIdentifier = isPersonalTeamBuild
    ? config.ios?.bundleIdentifier
    : identity.bundleIdentifier;

  // relyingParty is deliberately absent. Associated domains require Apple to
  // fetch an apple-app-site-association file naming the bundle from the domain,
  // and clerk.t3.codes is not ours to publish to, so claiming it would fail
  // quietly. Custom-scheme links, which pairing uses, are unaffected.
  const { associatedDomains: _associatedDomains, ...ios } = config.ios ?? {};
  const entitlements = ios.entitlements as Record<string, unknown> | undefined;

  return {
    ...config,
    name: identity.appName,
    slug: "d3-code",
    scheme: identity.scheme,
    // The app carries the same version as the rest of the fork rather than a
    // line of its own: every surface is built from one commit, and a phone
    // reporting a different number to the desktop beside it is a bug report
    // waiting to happen.
    version: readForkVersion(),
    updates: {
      ...config.updates,
      url: `https://u.expo.dev/${EAS_PROJECT_ID}`,
    },
    ios: {
      ...ios,
      bundleIdentifier,
      // Our own Apple team from the shell beats the one upstream pins.
      appleTeamId: repoEnv.T3CODE_APPLE_TEAM_ID?.trim() || ios.appleTeamId,
      ...(entitlements && "keychain-access-groups" in entitlements
        ? {
            entitlements: {
              ...entitlements,
              "keychain-access-groups": [`$(AppIdentifierPrefix)${bundleIdentifier}`],
            },
          }
        : {}),
    },
    android: {
      ...config.android,
      package: identity.bundleIdentifier,
    },
    plugins: (config.plugins ?? [])
      .filter((plugin) => !DROPPED_PLUGINS.has(pluginName(plugin)))
      .map(rewritePlugin),
    extra: {
      ...config.extra,
      eas: { ...config.extra?.eas, projectId: EAS_PROJECT_ID },
    },
    owner: "xalior",
  };
}
