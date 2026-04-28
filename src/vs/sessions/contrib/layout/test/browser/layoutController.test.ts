/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IChatService } from '../../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { Parts, IWorkbenchLayoutService } from '../../../../../workbench/services/layout/browser/layoutService.js';
import { IViewsService } from '../../../../../workbench/services/views/common/viewsService.js';
import { SessionStatus } from '../../../../services/sessions/common/session.js';
import { IActiveSession, ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { IWorkItem, WorkItemPriority, WorkItemStatus } from '../../../../services/workItems/common/workItem.js';
import { IWorkItemService } from '../../../../services/workItems/common/workItemService.js';
import { SESSIONS_FILES_CONTAINER_ID } from '../../../files/browser/files.contribution.js';
import { LayoutController } from '../../browser/layoutController.js';

function createActiveSession(): IActiveSession {
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

	return {
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
		activeChat: observableValue('session.activeChat', chat),
		capabilities: { supportsMultipleChats: false },
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

suite('LayoutController', () => {
	const disposables = new DisposableStore();

	teardown(() => {
		disposables.clear();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	test('treats the active work item working directory as workspace when the active session has not resolved one yet', () => {
		const instantiationService = disposables.add(new TestInstantiationService());
		const openViewContainerCalls: string[] = [];
		const openViewCalls: string[] = [];
		const closeViewContainerCalls: string[] = [];
		const visibilityEmitter = new Emitter<{ partId: Parts; visible: boolean }>();

		instantiationService.stub(IWorkbenchLayoutService, new class extends mock<IWorkbenchLayoutService>() {
			override onDidChangePartVisibility = visibilityEmitter.event;
			override setPartHidden() { }
		}());
		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override activeSession = observableValue<IActiveSession | undefined>('activeSession', createActiveSession());
		}());
		instantiationService.stub(IWorkItemService, new class extends mock<IWorkItemService>() {
			override activeWorkItem = observableValue<IWorkItem | undefined>('activeWorkItem', createWorkItem(URI.parse('file:///worktree')));
		}());
		instantiationService.stub(IChatService, new class extends mock<IChatService>() {
			override onDidSubmitRequest = Event.None;
		}());
		instantiationService.stub(IViewsService, new class extends mock<IViewsService>() {
			override openViewContainer(id: string) {
				openViewContainerCalls.push(id);
				return undefined;
			}
			override openView(id: string) {
				openViewCalls.push(id);
				return undefined;
			}
			override closeViewContainer(id: string) {
				closeViewContainerCalls.push(id);
				return undefined;
			}
		}());

		disposables.add(instantiationService.createInstance(LayoutController));

		assert.deepStrictEqual(openViewContainerCalls, [SESSIONS_FILES_CONTAINER_ID]);
		assert.deepStrictEqual(openViewCalls, []);
		assert.deepStrictEqual(closeViewContainerCalls, []);
		visibilityEmitter.dispose();
	});
});
