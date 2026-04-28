/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IWorkspaceEditingService } from '../../../../../workbench/services/workspaces/common/workspaceEditing.js';
import { ISession, SessionStatus } from '../../../../services/sessions/common/session.js';
import { IActiveSession, ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { IWorkItem, WorkItemPriority, WorkItemStatus } from '../../../../services/workItems/common/workItem.js';
import { IWorkItemService } from '../../../../services/workItems/common/workItemService.js';
import { WorkspaceFolderManagementContribution } from '../../browser/workspaceFolderManagement.js';

function createSession(): IActiveSession {
	const chat = {
		resource: URI.parse('file:///session'),
		createdAt: new Date(),
		title: observableValue('chat.title', 'Session'),
		updatedAt: observableValue('chat.updatedAt', new Date()),
		status: observableValue('chat.status', SessionStatus.Untitled),
		changes: observableValue('chat.changes', []),
		modelId: observableValue('chat.modelId', undefined),
		mode: observableValue('chat.mode', undefined),
		isArchived: observableValue('chat.isArchived', false),
		isRead: observableValue('chat.isRead', true),
		lastTurnEnd: observableValue('chat.lastTurnEnd', undefined),
		description: observableValue('chat.description', undefined),
	};
	const session: ISession = {
		sessionId: 'session-1',
		resource: chat.resource,
		providerId: 'test-provider',
		sessionType: 'background',
		icon: Codicon.copilot,
		createdAt: chat.createdAt,
		workspace: observableValue('session.workspace', undefined),
		title: chat.title,
		updatedAt: chat.updatedAt,
		status: chat.status,
		changes: chat.changes,
		modelId: chat.modelId,
		mode: chat.mode,
		loading: observableValue('session.loading', false),
		isArchived: chat.isArchived,
		isRead: chat.isRead,
		lastTurnEnd: chat.lastTurnEnd,
		description: chat.description,
		gitHubInfo: observableValue('session.githubInfo', undefined),
		chats: observableValue('session.chats', [chat]),
		mainChat: chat,
		capabilities: { supportsMultipleChats: false },
	};

	return {
		...session,
		activeChat: observableValue('session.activeChat', chat),
	};
}

function createWorkItem(workingDirectory: URI): IWorkItem {
	return {
		id: 'work-item-1',
		title: observableValue('workItem.title', 'Work Item'),
		description: observableValue('workItem.description', ''),
		status: observableValue('workItem.status', WorkItemStatus.Open),
		priority: observableValue('workItem.priority', WorkItemPriority.Backlog),
		labels: observableValue('workItem.labels', []),
		linkedIssue: observableValue('workItem.linkedIssue', undefined),
		workingDirectory: observableValue('workItem.workingDirectory', workingDirectory),
		createdAt: new Date(),
		updatedAt: observableValue('workItem.updatedAt', new Date()),
		sessions: observableValue('workItem.sessions', []),
	};
}

suite('WorkspaceFolderManagementContribution', () => {
	const disposables = new DisposableStore();

	teardown(() => {
		disposables.clear();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	test('falls back to active work item working directory when the active session has no workspace yet', async () => {
		const instantiationService = disposables.add(new TestInstantiationService());
		const activeSession = observableValue<IActiveSession | undefined>('activeSession', createSession());
		const activeWorkItem = observableValue<IWorkItem | undefined>('activeWorkItem', createWorkItem(URI.parse('file:///worktree')));
		const folders: Array<{ uri: URI }> = [];
		const addCalls: URI[] = [];

		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override activeSession = activeSession;
		}());
		instantiationService.stub(IWorkItemService, new class extends mock<IWorkItemService>() {
			override activeWorkItem = activeWorkItem;
		}());
		instantiationService.stub(IUriIdentityService, { extUri });
		instantiationService.stub(IWorkspaceContextService, new class extends mock<IWorkspaceContextService>() {
			override getWorkspace() {
				return { folders } as unknown as ReturnType<IWorkspaceContextService['getWorkspace']>;
			}
			override getWorkbenchState() {
				return WorkbenchState.WORKSPACE;
			}
		}());
		instantiationService.stub(IWorkspaceEditingService, new class extends mock<IWorkspaceEditingService>() {
			override async addFolders(foldersToAdd: { uri: URI }[]) {
				for (const folder of foldersToAdd) {
					addCalls.push(folder.uri);
					folders.splice(0, folders.length, { uri: folder.uri });
				}
			}
			override async removeFolders() { }
			override async updateFolders() { }
		}());
		instantiationService.stub(IWorkspaceTrustManagementService, new class extends mock<IWorkspaceTrustManagementService>() {
			override getTrustedUris() {
				return [];
			}
			override async setUrisTrust() { }
		}());

		disposables.add(instantiationService.createInstance(WorkspaceFolderManagementContribution));
		await new Promise(resolve => setTimeout(resolve, 0));

		assert.deepStrictEqual(addCalls.map(uri => uri.toString()), ['file:///worktree']);
	});
});
