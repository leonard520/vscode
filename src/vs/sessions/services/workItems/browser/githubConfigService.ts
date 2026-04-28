/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IGitHubRepoConfig, IWorkItemGitHubConfigService } from '../common/githubConfig.js';
import { IGitHubService } from '../../../contrib/github/browser/githubService.js';

const GITHUB_REPOS_STORAGE_KEY = 'workItems.githubRepos';
const LOG_PREFIX = '[WorkItemGitHubConfigService]';

interface IGitHubRepoConfigData {
	readonly repos: readonly IGitHubRepoConfig[];
}

class WorkItemGitHubConfigService extends Disposable implements IWorkItemGitHubConfigService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeRepos = this._register(new Emitter<void>());
	readonly onDidChangeRepos: Event<void> = this._onDidChangeRepos.event;

	private _repos: IGitHubRepoConfig[] = [];

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@ILogService private readonly _logService: ILogService,
		@IGitHubService private readonly _githubService: IGitHubService,
	) {
		super();
		this._loadFromStorage();
	}

	getRepos(): readonly IGitHubRepoConfig[] {
		return this._repos;
	}

	async addRepo(owner: string, repo: string): Promise<void> {
		// Check for duplicates
		if (this._repos.some(r => r.owner === owner && r.repo === repo)) {
			this._logService.debug(LOG_PREFIX, `Repository ${owner}/${repo} already configured`);
			return;
		}

		// Validate the repo exists
		const valid = await this.validateRepo(owner, repo);
		if (!valid) {
			throw new Error(`Repository ${owner}/${repo} not found or inaccessible`);
		}

		this._repos.push({
			owner,
			repo,
			fullName: `${owner}/${repo}`,
		});

		this._saveToStorage();
		this._logService.debug(LOG_PREFIX, `Added repository: ${owner}/${repo}`);
		this._onDidChangeRepos.fire();
	}

	removeRepo(owner: string, repo: string): void {
		const idx = this._repos.findIndex(r => r.owner === owner && r.repo === repo);
		if (idx < 0) {
			return;
		}

		this._repos.splice(idx, 1);
		this._saveToStorage();
		this._logService.debug(LOG_PREFIX, `Removed repository: ${owner}/${repo}`);
		this._onDidChangeRepos.fire();
	}

	async validateRepo(owner: string, repo: string): Promise<boolean> {
		try {
			this._githubService.getRepository(owner, repo);
			return true;
		} catch {
			return false;
		}
	}

	private _loadFromStorage(): void {
		const raw = this._storageService.get(GITHUB_REPOS_STORAGE_KEY, StorageScope.PROFILE);
		if (!raw) {
			return;
		}

		try {
			const data: IGitHubRepoConfigData = JSON.parse(raw);
			this._repos = [...data.repos];
		} catch (e) {
			this._logService.error(LOG_PREFIX, 'Failed to load GitHub repos from storage', e);
		}
	}

	private _saveToStorage(): void {
		const data: IGitHubRepoConfigData = { repos: this._repos };
		this._storageService.store(GITHUB_REPOS_STORAGE_KEY, JSON.stringify(data), StorageScope.PROFILE, StorageTarget.USER);
	}
}

registerSingleton(IWorkItemGitHubConfigService, WorkItemGitHubConfigService, InstantiationType.Delayed);
