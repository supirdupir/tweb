/*
 * https://github.com/morethanwords/tweb
 * Copyright (C) 2019-2021 Eduard Kuzmenko
 * https://github.com/morethanwords/tweb/blob/master/LICENSE
 */

import type {Database} from '.';
import {ActiveAccountNumber} from '@lib/accounts/types';
import {panelScopedName} from '@lib/panelAccountScope';
import {MOUNT_CLASS_TO} from '@config/debug';

export type AccountDatabase = Database<'session' | 'stickerSets' | 'users' | 'chats' | 'messages' | 'dialogs' | 'webapp'>;
export type CommonDatabase = Database<'session' | 'localStorage'>;

// All three DB-name builders below scope by Panel `account_id` (URL param)
// when present. `panelScopedName` returns the base name unchanged in
// standalone mode (no `account_id`) so existing tweb users keep their
// on-disk schema. See lib/panelAccountScope.ts.

export const getOldDatabaseState = (): AccountDatabase => ({
  name: panelScopedName(`tweb`),
  version: 7,
  stores: [
    {
      name: 'session'
    },
    {
      name: 'stickerSets'
    },
    {
      name: 'users'
    },
    {
      name: 'chats'
    },
    {
      name: 'dialogs'
    },
    {
      name: 'messages'
    }
  ]
});

export const getCommonDatabaseState = (): CommonDatabase => ({
  name: panelScopedName(`tweb-common`),
  version: 8,
  stores: [
    {
      name: 'session'
    },
    {
      name: 'localStorage', // not used (
      encryptedName: 'localStorage__encrypted'
    }
  ]
});

export const getDatabaseState = (
  accountNumber: ActiveAccountNumber
): Database<'session' | 'stickerSets' | 'users' | 'chats' | 'messages' | 'dialogs' | 'webapp'> => ({
  name: panelScopedName(`tweb-account-${accountNumber}`),
  version: 9,
  stores: [
    {
      name: 'session',
      encryptedName: 'session__encrypted'
    },
    {
      name: 'stickerSets',
      encryptedName: 'stickerSets__encrypted'
    },
    {
      name: 'users',
      encryptedName: 'users__encrypted'
    },
    {
      name: 'chats',
      encryptedName: 'chats__encrypted'
    },
    {
      name: 'dialogs',
      encryptedName: 'dialogs__encrypted'
    },
    {
      name: 'messages',
      encryptedName: 'messages__encrypted'
    },
    {
      name: 'webapp',
      encryptedName: 'webapp__encrypted'
    }
  ]
});

MOUNT_CLASS_TO.getDatabaseState = getDatabaseState;
