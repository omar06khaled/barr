// Expo SDK 52+ configures monorepo watch folders automatically.
const { getSentryExpoConfig } = require('@sentry/react-native/metro');
const config = getSentryExpoConfig(__dirname);
// expo-sqlite on web (used only for local previews) ships a wasm module.
config.resolver.assetExts.push('wasm');
module.exports = config;
