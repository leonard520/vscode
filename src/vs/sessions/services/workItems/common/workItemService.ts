/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IObservable } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ISession } from '../../sessions/common/session.js';
import { ILinkedGitHubIssue, IWorkItem, WorkItemPriority, WorkItemStatus } from './workItem.js';

export interface IWorkItemChangeEvent {
	readonly added: readonly IWorkItem[];
	readonly removed: readonly IWorkItem[];
	readonly changed: readonly IWorkItem[];
}

export interface IWorkItemCreateData {
	readonly title: string;
	readonly description?: string;
	readonly priority?: WorkItemPriority;
	readonly labels?: string[];
	readonly linkedIssue?: ILinkedGitHubIssue;
	readonly workingDirectory?: URI;
}

export interface IWorkItemUpdateData {
	readonly title?: string;
	readonly description?: string;
	readonly status?: WorkItemStatus;
	readonly priority?: WorkItemPriority;
	readonly labels?: string[];
	readonly linkedIssue?: ILinkedGitHubIssue | undefined;
	readonly workingDirectory?: URI | undefined;
}

export const IWorkItemService = createDecorator<IWorkItemService>('workItemService');

export interface IWorkItemService {
	readonly _serviceBrand: undefined;

	/** Event fired when work items change. */
	readonly onDidChangeWorkItems: Event<IWorkItemChangeEvent>;

	/** The currently active (selected) work item. */
	readonly activeWorkItem: IObservable<IWorkItem | undefined>;

	// CRUD

	/** Get all work items. */
	getWorkItems(): readonly IWorkItem[];

	/** Get a work item by ID. */
	getWorkItem(id: string): IWorkItem | undefined;

	/** Create a new work item. Returns the created item. */
	createWorkItem(data: IWorkItemCreateData): IWorkItem;

	/** Update a work item's properties. */
	updateWorkItem(id: string, changes: IWorkItemUpdateData): void;

	/** Delete a work item. */
	deleteWorkItem(id: string): void;

	/** Set the active work item (updates sidebar selection + chat bar). */
	setActiveWorkItem(id: string | undefined): void;

	// Session association

	/** Associate a session with a work item. */
	addSession(workItemId: string, sessionId: string): void;

	/** Disassociate a session from a work item. */
	removeSession(workItemId: string, sessionId: string): void;

	/**
	 * Persist the explicitly selected history session for a work item.
	 * This is used by direct tab switching so later restore or alignment logic
	 * reopens the session the user actually chose instead of falling back.
	 */
	setPreferredSessionForWorkItem(workItemId: string, sessionId: string | undefined): void;

	/** Create a new agent session for a work item, using its working directory. */
	createSessionForWorkItem(workItemId: string): Promise<ISession>;
}
