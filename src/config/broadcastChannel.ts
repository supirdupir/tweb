import {panelScopedName} from '@lib/panelAccountScope';

// Scoped by Panel account_id when in Panel mode so two iframes for
// different accounts don't deliver `reload` events to each other (the
// reload-on-version-bump flow is per-account, not cross-account). Returns
// 'webk-main-broadcast-channel' unchanged in standalone mode.
export const unversionedMainBroadcastChannelName = panelScopedName('webk-main-broadcast-channel');

/**
 * Make sure to add handling of different versions of the app open in different tabs when adding more complex events
 */
export type MainBroadcastChannelEvents = {
  reload: void;
};
