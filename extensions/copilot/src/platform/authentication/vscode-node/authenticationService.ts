/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { authentication, AuthenticationGetSessionOptions, AuthenticationSession } from 'vscode';
import { TaskSingler } from '../../../util/common/taskSingler';
import { AuthProviderId, IConfigurationService } from '../../configuration/common/configurationService';
import { IDomainService } from '../../endpoint/common/domainService';
import { ILogService } from '../../log/common/logService';
import { authProviderId, BaseAuthenticationService, StrictAuthenticationPresentationOptions } from '../common/authentication';
import { ICopilotTokenManager } from '../common/copilotTokenManager';
import { ICopilotTokenStore } from '../common/copilotTokenStore';
import { getAlignedSession, getAnyAuthSession } from './session';

export class AuthenticationService extends BaseAuthenticationService {
	private _taskSingler = new TaskSingler<AuthenticationSession | undefined>();
	// Separate singler for interactive (createIfNone) flows so that multiple concurrent callers
	// asking for the same kind of session at the same time only result in a single sign-in prompt.
	// `forceNewSession` is intentionally not deduped because its semantics are "force a new prompt".
	private _interactiveTaskSingler = new TaskSingler<AuthenticationSession | undefined>();

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@IDomainService private readonly _domainService: IDomainService,
		@ILogService logService: ILogService,
		@ICopilotTokenStore tokenStore: ICopilotTokenStore,
		@ICopilotTokenManager tokenManager: ICopilotTokenManager
	) {
		super(logService, tokenStore, tokenManager, configurationService);
		this._register(authentication.onDidChangeSessions((e) => {
			if (e.provider.id === authProviderId(configurationService) || e.provider.id === AuthProviderId.Microsoft) {
				this._logService.debug('Handling onDidChangeSession.');
				void this._handleAuthChangeEvent();
			}
		}));
		this._register(this._domainService.onDidChangeDomains((e) => {
			if (e.dotcomUrlChanged) {
				this._logService.debug('Handling onDidChangeDomains.');
				void this._handleAuthChangeEvent();
			}
		}));

		void this._handleAuthChangeEvent();
	}

	override async getGitHubSession(kind: 'permissive' | 'any', options: AuthenticationGetSessionOptions & { createIfNone: StrictAuthenticationPresentationOptions }): Promise<AuthenticationSession>;
	override async getGitHubSession(kind: 'permissive' | 'any', options: AuthenticationGetSessionOptions & { forceNewSession: StrictAuthenticationPresentationOptions }): Promise<AuthenticationSession>;
	override async getGitHubSession(kind: 'permissive' | 'any', options: AuthenticationGetSessionOptions): Promise<AuthenticationSession | undefined> {
		if (kind === 'permissive') {
			const func = () => getAlignedSession(this._configurationService, options);
			const session = await this._runWithSingler('permissive', func, options);
			this._permissiveGitHubSession = session;
			return session;
		} else {
			const func = () => getAnyAuthSession(this._configurationService, options);
			const session = await this._runWithSingler('any', func, options);
			this._anyGitHubSession = session;
			return session;
		}
	}

	protected async getAnyAdoSession(options?: AuthenticationGetSessionOptions): Promise<AuthenticationSession | undefined> {
		const adoAuthProviderId = 'microsoft';
		const adoScopes = ['499b84ac-1321-427f-aa17-267ca6975798/.default', 'offline_access'];
		const func = async () => await authentication.getSession(adoAuthProviderId, adoScopes, options);
		const session = await this._runWithSingler('ado', func, options);
		this._anyAdoSession = session;
		return session;
	}

	private _runWithSingler(key: string, func: () => Promise<AuthenticationSession | undefined>, options?: AuthenticationGetSessionOptions): Promise<AuthenticationSession | undefined> {
		// `forceNewSession` semantically means "always show a fresh prompt", so it bypasses dedup entirely.
		if (options?.forceNewSession) {
			return func();
		}
		// Dedupe interactive (createIfNone) requests on a separate singler so that N concurrent callers
		// only produce a single sign-in prompt. Without this, opening views that fan out into multiple
		// parallel API calls (e.g. listing cloud sessions) can spawn many duplicate sign-in dialogs.
		if (options?.createIfNone) {
			return this._interactiveTaskSingler.getOrCreate(key, func);
		}
		return this._taskSingler.getOrCreate(key, func);
	}

	async getAdoAccessTokenBase64(options?: AuthenticationGetSessionOptions): Promise<string | undefined> {
		const session = await this.getAnyAdoSession(options);
		return session ? Buffer.from(`PAT:${session.accessToken}`, 'utf8').toString('base64') : undefined;
	}
}
