// Expo SDK 52+ configures monorepo watch folders automatically.
const { getSentryExpoConfig } = require('@sentry/react-native/metro');
module.exports = getSentryExpoConfig(__dirname);
