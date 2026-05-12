import {MOUNT_CLASS_TO} from '@config/debug';
import App from '@config/app';
import tsNow from '@helpers/tsNow';
import type {TrueDcId} from '@types';

import sessionStorage from '@lib/sessionStorage';
import DeferredIsUsingPasscode from '@lib/passcode/deferredIsUsingPasscode';
import StaticUtilityClass from '@lib/staticUtilityClass';

import {AccountSessionData, ActiveAccountNumber} from '@lib/accounts/types';
import {MAX_ACCOUNTS} from '@lib/accounts/constants';
import bytesToHex from '@helpers/bytes/bytesToHex';
import randomize from '@helpers/array/randomize';

export class AccountController extends StaticUtilityClass {
  static async getTotalAccounts() {
    const promises = ([1, 2, 3, 4] as const).map((accountNumber) => this.get(accountNumber));
    const allAccountsData = await Promise.all(promises);
    return allAccountsData.filter((accountData) => !!accountData.userId).length;
  }

  static async getUnencryptedTotalAccounts() {
    return sessionStorage.get('number_of_accounts');
  }

  static async getUserIds() {
    const promises = ([1, 2, 3, 4] as const).map((accountNumber) => this.get(accountNumber));
    const allAccountsData = await Promise.all(promises);
    return allAccountsData.map((accountData) => accountData.userId).filter(Boolean);
  }

  static async get(accountNumber: ActiveAccountNumber, updating?: boolean) {
    const data = await sessionStorage.get(`account${accountNumber}`) || {} as AccountSessionData;

    if(!updating && this.fillMissingData(data)) {
      await this.update(accountNumber, data);
    }

    return data;
  }

  static fillMissingData(data: AccountSessionData) {
    return [
      this.fillFingerprint(data),
      this.fillPushKey(data)
    ].some(Boolean);
  }

  static fillFingerprint(data: AccountSessionData) {
    if(!data.auth_key_fingerprint) {
      const authKey = data[`dc${App.baseDcId}_auth_key`];
      if(!authKey) {
        return false;
      }

      data.auth_key_fingerprint = authKey ? authKey.slice(0, 8) : undefined;
      return true;
    }

    return false;
  }

  static fillPushKey(data: AccountSessionData) {
    if(!data.push_key && data.userId) {
      data.push_key = bytesToHex(randomize(new Uint8Array(256)));
      return true;
    }

    return false;
  }

  static async update(accountNumber: ActiveAccountNumber, data: Partial<AccountSessionData>, overrideAll = false) {
    const prevData = await this.get(accountNumber, true);

    const updatedData = {
      ...(overrideAll ? {} : prevData),
      ...data
    };

    this.fillMissingData(updatedData);

    await sessionStorage.set({
      [`account${accountNumber}`]: updatedData
    });

    if(accountNumber === 1) {
      // Plan 06 T17: after a successful auth save, snapshot to Panel for audit.
      // Bridge is undefined when running outside Panel iframe — no-op.
      // Only fires for accountNumber === 1 (Panel's single-account slot).
      //
      // ⚠️ This code path runs in BOTH main thread (loadState init, passcode
      // actions) AND SharedWorker (apiManager.setUserAuth, etc.). In worker
      // context, bare `window` throws ReferenceError. globalThis.window is
      // undefined in worker → optional-chain returns undefined → silent no-op.
      // Worker callers route through the rootScope 'user_auth' listener
      // installed by panelBridge.ts initPanelBridge() instead.
      const bridge = (globalThis as any).window?.__panelBridge;
      const dcKey = updatedData.dcId ? `dc${updatedData.dcId}_auth_key` as keyof AccountSessionData : undefined;
      const authKeyHex = dcKey ? updatedData[dcKey] as string | undefined : undefined;
      console.warn('[panelBridge] accountController.update gate', {
        accountNumber,
        hasBridge: !!bridge,
        hasUserId: !!updatedData.userId,
        hasDcId: !!updatedData.dcId,
        hasAuthKeyHex: !!authKeyHex
      });
      if(bridge && updatedData.userId && updatedData.dcId) {
        if(authKeyHex) {
          try {
            await bridge.onSessionSaved({
              authKeyHex,
              dcId: updatedData.dcId,
              userId: typeof updatedData.userId === 'number' ? updatedData.userId : Number(updatedData.userId)
            });
          } catch(e) {
            console.error('[panelBridge] onSessionSaved failed:', e);
            // Audit failure is non-fatal — auth still works locally.
          }
        }
      }

      await this.updateStorageForLegacy(updatedData);
    }

    (async() => {
      sessionStorage.set({
        number_of_accounts: await this.getTotalAccounts()
      });
    })();

    return updatedData;
  }

  /**
   * Shifts 4 -> 3, 3 -> 2 ... depending on which account you need to delete
   * @param upTo Account to delete basically
   */
  static async shiftAccounts(upTo: ActiveAccountNumber) {
    for(let i = upTo; i <= MAX_ACCOUNTS; i++) {
      await sessionStorage.delete(`account${i as ActiveAccountNumber}`);
      if(i < MAX_ACCOUNTS) {
        const toMove = await this.get((i + 1) as ActiveAccountNumber);
        toMove.userId && (await this.update(i as ActiveAccountNumber, toMove, true));
      }
    }
  }

  /**
   * Use `null` when needing to remove the values (e.g. when enabling passcode)
   */
  static async updateStorageForLegacy(accountData: Partial<AccountSessionData> | null) {
    if(accountData !== null && await DeferredIsUsingPasscode.isUsingPasscode()) return; // We can't expose keys if there's a passcode set

    if(accountData === null) accountData = {};

    const obj: Parameters<typeof sessionStorage['set']>[0] = {};
    const toClear: (keyof typeof obj)[] = [];

    const set = <T extends keyof typeof obj>(key: T, value: typeof obj[T]) => {
      if(value) obj[key] = value;
      else toClear.push(key);
    };

    for(let i = 1; i <= 5; i++) {
      const authKeyKey = `dc${i as TrueDcId}_auth_key` as const;
      const serverSaltKey = `dc${i as TrueDcId}_server_salt` as const;

      set(authKeyKey, accountData[authKeyKey]);
      set(serverSaltKey, accountData[serverSaltKey]);
    }

    accountData['auth_key_fingerprint'] && set('auth_key_fingerprint', accountData['auth_key_fingerprint']);
    set('user_auth', accountData['userId'] && {
      date: tsNow(true),
      id: accountData.userId,
      dcID: accountData.dcId || 0
    });
    set('dc', accountData.dcId);

    await Promise.all([
      sessionStorage.set(obj),
      Promise.all(toClear.map((key) => sessionStorage.delete(key)))
    ]);
  }
}

MOUNT_CLASS_TO.AccountController = AccountController;

export default AccountController;
