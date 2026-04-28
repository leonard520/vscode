/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IGitHubChangedFile, IGitHubIssue, IGitHubIssueComment } from '../common/types.js';
import { GitHubApiClient } from './githubApiClient.js';
import { GitHubRepositoryFetcher } from './fetchers/githubRepositoryFetcher.js';
import { GitHubPRFetcher } from './fetchers/githubPRFetcher.js';
import { GitHubPRCIFetcher } from './fetchers/githubPRCIFetcher.js';
import { GitHubRepositoryModel } from './models/githubRepositoryModel.js';
import { GitHubPullRequestModel } from './models/githubPullRequestModel.js';
import { GitHubPullRequestCIModel } from './models/githubPullRequestCIModel.js';
import { GitHubChangesFetcher } from './fetchers/githubChangesFetcher.js';

export interface IGitHubService {
	readonly _serviceBrand: undefined;

	/**
	 * Get or create a reactive model for a GitHub repository.
	 * The model is cached by owner/repo key and disposed when the service is disposed.
	 */
	getRepository(owner: string, repo: string): GitHubRepositoryModel;

	/**
	 * Get or create a reactive model for a GitHub pull request.
	 * The model is cached by owner/repo/prNumber key and disposed when the service is disposed.
	 */
	getPullRequest(owner: string, repo: string, prNumber: number): GitHubPullRequestModel;

	/**
	 * Get or create a reactive model for CI checks on a pull request head ref.
	 * The model is cached by owner/repo/headRef key and disposed when the service is disposed.
	 */
	getPullRequestCI(owner: string, repo: string, headRef: string): GitHubPullRequestCIModel;

	/**
	 * List files changed between two refs using the GitHub compare API.
	 */
	getChangedFiles(owner: string, repo: string, base: string, head: string): Promise<readonly IGitHubChangedFile[]>;

	/**
	 * Fetch a single GitHub issue.
	 */
	getIssue(owner: string, repo: string, issueNumber: number): Promise<IGitHubIssue>;

	/**
	 * Create a new GitHub issue. Returns the created issue.
	 */
	createIssue(owner: string, repo: string, title: string, body?: string, labels?: string[]): Promise<IGitHubIssue>;

	/**
	 * Update a GitHub issue (title, body, state, labels).
	 */
	updateIssue(owner: string, repo: string, issueNumber: number, changes: { title?: string; body?: string; state?: 'open' | 'closed'; labels?: string[] }): Promise<IGitHubIssue>;

	/**
	 * Add a comment to a GitHub issue.
	 */
	createIssueComment(owner: string, repo: string, issueNumber: number, body: string): Promise<void>;

	/**
	 * Search issues in a repo.
	 */
	searchIssues(owner: string, repo: string, query?: string, state?: 'open' | 'closed' | 'all'): Promise<readonly IGitHubIssue[]>;

	/**
	 * List open issues assigned to the authenticated user for a repository.
	 */
	getAssignedIssues(owner: string, repo: string): Promise<readonly IGitHubIssue[]>;

	/**
	 * Fetch comments on a GitHub issue.
	 */
	getIssueComments(owner: string, repo: string, issueNumber: number): Promise<readonly IGitHubIssueComment[]>;
}

export const IGitHubService = createDecorator<IGitHubService>('sessionsGitHubService');

const LOG_PREFIX = '[GitHubService]';

export class GitHubService extends Disposable implements IGitHubService {

	declare readonly _serviceBrand: undefined;

	private readonly _apiClient: GitHubApiClient;
	private readonly _repoFetcher: GitHubRepositoryFetcher;
	private readonly _changesFetcher: GitHubChangesFetcher;
	private readonly _prFetcher: GitHubPRFetcher;
	private readonly _ciFetcher: GitHubPRCIFetcher;

	private readonly _repositories = this._register(new DisposableMap<string, GitHubRepositoryModel>());
	private readonly _pullRequests = this._register(new DisposableMap<string, GitHubPullRequestModel>());
	private readonly _ciModels = this._register(new DisposableMap<string, GitHubPullRequestCIModel>());

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		this._apiClient = this._register(instantiationService.createInstance(GitHubApiClient));
		this._repoFetcher = new GitHubRepositoryFetcher(this._apiClient);
		this._changesFetcher = new GitHubChangesFetcher(this._apiClient);
		this._prFetcher = new GitHubPRFetcher(this._apiClient);
		this._ciFetcher = new GitHubPRCIFetcher(this._apiClient);
	}

	getRepository(owner: string, repo: string): GitHubRepositoryModel {
		const key = `${owner}/${repo}`;
		let model = this._repositories.get(key);
		if (!model) {
			this._logService.trace(`${LOG_PREFIX} Creating repository model for ${key}`);
			model = new GitHubRepositoryModel(owner, repo, this._repoFetcher, this._logService);
			this._repositories.set(key, model);
		}
		return model;
	}

	getPullRequest(owner: string, repo: string, prNumber: number): GitHubPullRequestModel {
		const key = `${owner}/${repo}/${prNumber}`;
		let model = this._pullRequests.get(key);
		if (!model) {
			this._logService.trace(`${LOG_PREFIX} Creating PR model for ${key}`);
			model = new GitHubPullRequestModel(owner, repo, prNumber, this._prFetcher, this._logService);
			this._pullRequests.set(key, model);
		}
		return model;
	}

	getPullRequestCI(owner: string, repo: string, headRef: string): GitHubPullRequestCIModel {
		const key = `${owner}/${repo}/${headRef}`;
		let model = this._ciModels.get(key);
		if (!model) {
			this._logService.trace(`${LOG_PREFIX} Creating CI model for ${key}`);
			model = new GitHubPullRequestCIModel(owner, repo, headRef, this._ciFetcher, this._logService);
			this._ciModels.set(key, model);
		}
		return model;
	}

	getChangedFiles(owner: string, repo: string, base: string, head: string): Promise<readonly IGitHubChangedFile[]> {
		return this._changesFetcher.getChangedFiles(owner, repo, base, head);
	}

	async getIssue(owner: string, repo: string, issueNumber: number): Promise<IGitHubIssue> {
		this._logService.trace(`${LOG_PREFIX} Fetching issue ${owner}/${repo}#${issueNumber}`);
		const raw = await this._apiClient.request<any>('GET', `/repos/${owner}/${repo}/issues/${issueNumber}`, 'getIssue');
		return mapIssue(raw);
	}

	async createIssue(owner: string, repo: string, title: string, body?: string, labels?: string[]): Promise<IGitHubIssue> {
		this._logService.trace(`${LOG_PREFIX} Creating issue in ${owner}/${repo}: "${title}"`);
		const raw = await this._apiClient.request<any>('POST', `/repos/${owner}/${repo}/issues`, 'createIssue', {
			title,
			body: body ?? '',
			labels: labels ?? [],
		});
		return mapIssue(raw);
	}

	async updateIssue(owner: string, repo: string, issueNumber: number, changes: { title?: string; body?: string; state?: 'open' | 'closed'; labels?: string[] }): Promise<IGitHubIssue> {
		this._logService.trace(`${LOG_PREFIX} Updating issue ${owner}/${repo}#${issueNumber}`);
		const raw = await this._apiClient.request<any>('PATCH', `/repos/${owner}/${repo}/issues/${issueNumber}`, 'updateIssue', changes);
		return mapIssue(raw);
	}

	async createIssueComment(owner: string, repo: string, issueNumber: number, body: string): Promise<void> {
		this._logService.trace(`${LOG_PREFIX} Adding comment to issue ${owner}/${repo}#${issueNumber}`);
		await this._apiClient.request<unknown>('POST', `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, 'createIssueComment', { body });
	}

	async searchIssues(owner: string, repo: string, query?: string, state?: 'open' | 'closed' | 'all'): Promise<readonly IGitHubIssue[]> {
		this._logService.trace(`${LOG_PREFIX} Searching issues in ${owner}/${repo} (state=${state ?? 'open'}, query=${query ?? ''})`);
		const params = new URLSearchParams();
		params.set('state', state ?? 'open');
		params.set('per_page', '50');
		if (query) {
			// Use the search endpoint for text queries
			params.set('q', query);
		}
		const raw = await this._apiClient.request<any[]>('GET', `/repos/${owner}/${repo}/issues?${params.toString()}`, 'searchIssues');
		// Filter out pull requests (GitHub Issues API includes PRs)
		return raw.filter(item => !item.pull_request).map(mapIssue);
	}

	async getAssignedIssues(owner: string, repo: string): Promise<readonly IGitHubIssue[]> {
		this._logService.trace(`${LOG_PREFIX} Fetching assigned issues for ${owner}/${repo}`);
		const issues: IGitHubIssue[] = [];

		for (let page = 1; ; page++) {
			const params = new URLSearchParams();
			params.set('q', `repo:${owner}/${repo} is:issue is:open assignee:@me`);
			params.set('per_page', '100');
			params.set('page', String(page));

			const raw = await this._apiClient.request<{ items?: any[] }>('GET', `/search/issues?${params.toString()}`, 'getAssignedIssues');
			const pageItems = (raw.items ?? []).filter(item => !item.pull_request).map(mapIssue);
			issues.push(...pageItems);

			if (pageItems.length < 100) {
				break;
			}
		}

		return issues;
	}

	async getIssueComments(owner: string, repo: string, issueNumber: number): Promise<readonly IGitHubIssueComment[]> {
		this._logService.trace(`${LOG_PREFIX} Fetching comments for issue ${owner}/${repo}#${issueNumber}`);
		const raw = await this._apiClient.request<any[]>('GET', `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`, 'getIssueComments');
		return raw.map(mapIssueComment);
	}
}

function mapIssue(raw: any): IGitHubIssue {
	return {
		number: raw.number,
		title: raw.title,
		body: raw.body ?? '',
		state: raw.state,
		labels: (raw.labels ?? []).map((l: any) => ({ name: l.name, color: l.color })),
		createdAt: raw.created_at,
		updatedAt: raw.updated_at,
		htmlUrl: raw.html_url,
		user: { login: raw.user.login, avatarUrl: raw.user.avatar_url },
	};
}

function mapIssueComment(raw: any): IGitHubIssueComment {
	return {
		id: raw.id,
		body: raw.body ?? '',
		user: { login: raw.user.login, avatarUrl: raw.user.avatar_url },
		createdAt: raw.created_at,
		updatedAt: raw.updated_at,
		htmlUrl: raw.html_url,
		authorAssociation: raw.author_association ?? '',
	};
}
