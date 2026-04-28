/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IObservable } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { ISession } from '../../sessions/common/session.js';

/**
 * Status of a work item. Mirrors GitHub Issue states.
 */
export const enum WorkItemStatus {
	Open = 'open',
	Closed = 'closed',
}

/**
 * Priority levels for work items.
 */
export const enum WorkItemPriority {
	Focus = 'focus',
	UpNext = 'up-next',
	Backlog = 'backlog',
}

/**
 * A GitHub Issue linked to a work item.
 */
export interface ILinkedGitHubIssue {
	/** GitHub repository owner. */
	readonly owner: string;
	/** GitHub repository name. */
	readonly repo: string;
	/** Issue number. */
	readonly number: number;
	/** Issue URL (for opening in browser). */
	readonly url: string;
}

/**
 * Serialized work item data for persistence.
 */
export interface IWorkItemData {
	/** Globally unique ID (UUID). */
	readonly id: string;
	/** User-facing title. */
	readonly title: string;
	/** Optional description (markdown). */
	readonly description: string;
	/** Open or Closed. */
	readonly status: WorkItemStatus;
	/** Focus, Up Next, or Backlog. */
	readonly priority: WorkItemPriority;
	/** User-assigned labels. */
	readonly labels: readonly string[];
	/** Linked GitHub Issue, if any. */
	readonly linkedIssue: ILinkedGitHubIssue | undefined;
	/** Local working directory path (file URI string). */
	readonly workingDirectory: string | undefined;
	/** ISO timestamp of creation. */
	readonly createdAt: string;
	/** ISO timestamp of last update. */
	readonly updatedAt: string;
	/** Session IDs associated with this work item. */
	readonly sessionIds: readonly string[];
	/** Last session explicitly viewed for this work item. */
	readonly activeSessionId?: string;
}

/**
 * Reactive work item model used in the UI layer.
 */
export interface IWorkItem {
	/** Globally unique ID (UUID). */
	readonly id: string;

	// Reactive properties (IObservable)

	/** User-facing title. Syncs with GitHub Issue title if linked. */
	readonly title: IObservable<string>;
	/** Optional description. */
	readonly description: IObservable<string>;
	/** Open or Closed. */
	readonly status: IObservable<WorkItemStatus>;
	/** Focus, Up Next, or Backlog. */
	readonly priority: IObservable<WorkItemPriority>;
	/** User-assigned labels. Syncs with GitHub Issue labels if linked. */
	readonly labels: IObservable<readonly string[]>;
	/** Linked GitHub Issue, if any. */
	readonly linkedIssue: IObservable<ILinkedGitHubIssue | undefined>;
	/** Local working directory URI, if any. */
	readonly workingDirectory: IObservable<URI | undefined>;
	/** Creation timestamp. */
	readonly createdAt: Date;
	/** Last updated timestamp. */
	readonly updatedAt: IObservable<Date>;
	/** Sessions associated with this work item. */
	readonly sessions: IObservable<readonly ISession[]>;
}
