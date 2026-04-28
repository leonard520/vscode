/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * A configured GitHub repository that users can create issues in.
 */
export interface IGitHubRepoConfig {
	/** Owner (user or organization). */
	readonly owner: string;
	/** Repository name. */
	readonly repo: string;
	/** Display name: "owner/repo". */
	readonly fullName: string;
}

export const IWorkItemGitHubConfigService = createDecorator<IWorkItemGitHubConfigService>('workItemGitHubConfigService');

export interface IWorkItemGitHubConfigService {
	readonly _serviceBrand: undefined;

	/** Event fired when configured repos change. */
	readonly onDidChangeRepos: Event<void>;

	/** Get all configured GitHub repos. */
	getRepos(): readonly IGitHubRepoConfig[];

	/** Add a GitHub repo to the configuration. */
	addRepo(owner: string, repo: string): Promise<void>;

	/** Remove a GitHub repo from the configuration. */
	removeRepo(owner: string, repo: string): void;

	/** Validate that the repo exists and user has access. Uses IGitHubService. */
	validateRepo(owner: string, repo: string): Promise<boolean>;
}
