/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IMenuService } from '../../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { SessionStatus, type ISession } from '../../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsListModelService } from '../../browser/views/sessionsListModelService.js';
import { type IWorkItem, WorkItemPriority, WorkItemStatus } from '../../../../services/workItems/common/workItem.js';
import { IWorkItemService } from '../../../../services/workItems/common/workItemService.js';
import { SessionsTitleBarWidget } from '../../browser/sessionsTitleBarWidget.js';

function createSession(title: string): ISession {
	const resource = URI.parse('vscode-agent-session:/active');
	const chat = {
		resource,
		createdAt: new Date(),
		title: observableValue('chat.title', title),
		updatedAt: observableValue('chat.updatedAt', new Date()),
		status: observableValue('chat.status', SessionStatus.Completed),
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
		resource,
		providerId: 'test-provider',
		sessionType: 'background',
		icon: Codicon.copilot,
		createdAt: chat.createdAt,
		workspace: observableValue('session.workspace', {
			label: 'repo',
			icon: Codicon.folder,
			repositories: [],
			requiresWorkspaceTrust: false,
		}),
		title: chat.title,
		updatedAt: chat.updatedAt,
		status: chat.status,
		changes: chat.changes,
		modelId: chat.modelId,
		mode: chat.mode,
		loading: observableValue('session.loading', false),
		isArchived: chat.isArchived,
		isRead: chat.isRead,
		description: chat.description,
		lastTurnEnd: chat.lastTurnEnd,
		gitHubInfo: observableValue('session.gitHubInfo', undefined),
		chats: observableValue('session.chats', [chat]),
		mainChat: chat,
		capabilities: { supportsMultipleChats: false },
	};
}

function createWorkItem(title: string): IWorkItem {
	return {
		id: 'work-item-1',
		title: observableValue('workItem.title', title),
		description: observableValue('workItem.description', ''),
		status: observableValue('workItem.status', WorkItemStatus.Open),
		priority: observableValue('workItem.priority', WorkItemPriority.Focus),
		labels: observableValue('workItem.labels', []),
		linkedIssue: observableValue('workItem.linkedIssue', undefined),
		workingDirectory: observableValue('workItem.workingDirectory', undefined),
		createdAt: new Date(),
		updatedAt: observableValue('workItem.updatedAt', new Date()),
		sessions: observableValue('workItem.sessions', []),
	};
}

suite('Sessions - SessionsTitleBarWidget', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('prefers the active work item title over the active session title', () => {
		const instantiationService = disposables.add(new TestInstantiationService());
		const activeSession = observableValue('activeSession', createSession('Generated Session Title'));
		const activeWorkItem = observableValue<IWorkItem | undefined>('activeWorkItem', createWorkItem('Work Item Title'));

		instantiationService.stub(IHoverService, new class extends mock<IHoverService>() {
			override setupManagedHover() {
				return { dispose() { } };
			}
		}());
		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override readonly activeSession = activeSession;
			override readonly activeProviderId = observableValue('activeProviderId', 'test-provider');
			override readonly onDidChangeSessions = Event.None;
		}());
		instantiationService.stub(IWorkItemService, new class extends mock<IWorkItemService>() {
			override readonly activeWorkItem = activeWorkItem;
			override readonly onDidChangeWorkItems = Event.None;
		}());
		instantiationService.stub(ISessionsListModelService, new class extends mock<ISessionsListModelService>() {
			override isSessionPinned(): boolean { return false; }
			override isSessionRead(): boolean { return true; }
		}());
		instantiationService.stub(IContextMenuService, new class extends mock<IContextMenuService>() { }());
		instantiationService.stub(IMenuService, new class extends mock<IMenuService>() { }());
		instantiationService.stub(IContextKeyService, new MockContextKeyService());
		instantiationService.stub(ISessionsProvidersService, new class extends mock<ISessionsProvidersService>() {
			override readonly onDidChangeProviders = Event.None;
		}());
		instantiationService.stub(ICommandService, new class extends mock<ICommandService>() { }());

		const widget = disposables.add(instantiationService.createInstance(
			SessionsTitleBarWidget,
			{ id: 'test', label: 'Test', enabled: true, tooltip: '', run: async () => { } } as unknown,
			undefined,
		));
		const container = document.createElement('div');
		widget.render(container);

		assert.strictEqual(container.querySelector('.agent-sessions-titlebar-label')?.textContent, 'Work Item Title');
	});

	test('keeps the work item title when the active session title changes', () => {
		const instantiationService = disposables.add(new TestInstantiationService());
		const activeSession = observableValue('activeSession', createSession('First Session Title'));
		const activeWorkItem = observableValue<IWorkItem | undefined>('activeWorkItem', createWorkItem('Benchmark'));

		instantiationService.stub(IHoverService, new class extends mock<IHoverService>() {
			override setupManagedHover() {
				return { dispose() { } };
			}
		}());
		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override readonly activeSession = activeSession;
			override readonly activeProviderId = observableValue('activeProviderId', 'test-provider');
			override readonly onDidChangeSessions = Event.None;
		}());
		instantiationService.stub(IWorkItemService, new class extends mock<IWorkItemService>() {
			override readonly activeWorkItem = activeWorkItem;
			override readonly onDidChangeWorkItems = Event.None;
		}());
		instantiationService.stub(ISessionsListModelService, new class extends mock<ISessionsListModelService>() {
			override isSessionPinned(): boolean { return false; }
			override isSessionRead(): boolean { return true; }
		}());
		instantiationService.stub(IContextMenuService, new class extends mock<IContextMenuService>() { }());
		instantiationService.stub(IMenuService, new class extends mock<IMenuService>() { }());
		instantiationService.stub(IContextKeyService, new MockContextKeyService());
		instantiationService.stub(ISessionsProvidersService, new class extends mock<ISessionsProvidersService>() {
			override readonly onDidChangeProviders = Event.None;
		}());
		instantiationService.stub(ICommandService, new class extends mock<ICommandService>() { }());

		const widget = disposables.add(instantiationService.createInstance(
			SessionsTitleBarWidget,
			{ id: 'test', label: 'Test', enabled: true, tooltip: '', run: async () => { } } as unknown,
			undefined,
		));
		const container = document.createElement('div');
		widget.render(container);

		activeSession.set(createSession('Second Session Title'), undefined);

		assert.strictEqual(container.querySelector('.agent-sessions-titlebar-label')?.textContent, 'Benchmark');
	});
});
