/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Event } from '../../../../../base/common/event.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService, IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IActiveSession, ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { IChat, ISession, SessionStatus } from '../../../../services/sessions/common/session.js';
import { IWorkItem, WorkItemPriority, WorkItemStatus } from '../../../../services/workItems/common/workItem.js';
import { IWorkItemService } from '../../../../services/workItems/common/workItemService.js';
import { WorkItemService } from '../../../../services/workItems/browser/workItemService.js';
import { SessionTabBar } from '../../browser/sessionTabBar.js';

function createSession(id: string, options?: { title?: string; status?: SessionStatus }): ISession {
	const resource = URI.parse(`vscode-agent-session:/${id}`);
	const chat = {
		resource,
		createdAt: new Date(),
		title: observableValue(`chat.title.${id}`, options?.title ?? `Session ${id}`),
		updatedAt: observableValue(`chat.updatedAt.${id}`, new Date()),
		status: observableValue(`chat.status.${id}`, options?.status ?? SessionStatus.Completed),
		changes: observableValue(`chat.changes.${id}`, []),
		modelId: observableValue(`chat.modelId.${id}`, undefined),
		mode: observableValue(`chat.mode.${id}`, undefined),
		isArchived: observableValue(`chat.isArchived.${id}`, false),
		isRead: observableValue(`chat.isRead.${id}`, true),
		lastTurnEnd: observableValue(`chat.lastTurnEnd.${id}`, undefined),
		description: observableValue(`chat.description.${id}`, undefined),
	};

	return {
		sessionId: id,
		resource,
		providerId: 'test-provider',
		sessionType: 'background',
		icon: Codicon.copilot,
		createdAt: chat.createdAt,
		workspace: observableValue(`session.workspace.${id}`, undefined),
		title: chat.title,
		updatedAt: chat.updatedAt,
		status: chat.status,
		changes: chat.changes,
		modelId: chat.modelId,
		mode: chat.mode,
		loading: observableValue(`session.loading.${id}`, false),
		isArchived: chat.isArchived,
		isRead: chat.isRead,
		lastTurnEnd: chat.lastTurnEnd,
		description: chat.description,
		gitHubInfo: observableValue(`session.githubInfo.${id}`, undefined),
		chats: observableValue<readonly IChat[]>(`session.chats.${id}`, [chat]),
		mainChat: chat,
		capabilities: { supportsMultipleChats: false },
	};
}

function createUntitledSession(id: string): ISession {
	return createSession(id, { title: '', status: SessionStatus.Untitled });
}

function createWorkItem(id: string, sessions: readonly ISession[]): IWorkItem {
	return {
		id,
		title: observableValue(`workItem.title.${id}`, 'Investigate visibility'),
		description: observableValue(`workItem.description.${id}`, ''),
		status: observableValue(`workItem.status.${id}`, WorkItemStatus.Open),
		priority: observableValue(`workItem.priority.${id}`, WorkItemPriority.Focus),
		labels: observableValue(`workItem.labels.${id}`, []),
		linkedIssue: observableValue(`workItem.linkedIssue.${id}`, undefined),
		workingDirectory: observableValue(`workItem.workingDirectory.${id}`, undefined),
		createdAt: new Date(),
		updatedAt: observableValue(`workItem.updatedAt.${id}`, new Date()),
		sessions: observableValue(`workItem.sessions.${id}`, sessions),
		discussions: observableValue(`workItem.discussions.${id}`, []),
	};
}

suite('Sessions - SessionTabBar', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let parent: HTMLElement;

	setup(() => {
		parent = document.createElement('div');
		document.body.appendChild(parent);
	});

	teardown(() => {
		parent.remove();
	});

	function createTabBar(activeWorkItem: IWorkItem | undefined, activeSession: ISession | undefined) {
		const instantiationService = store.add(new TestInstantiationService());
		const activeWorkItemObservable = observableValue<IWorkItem | undefined>('activeWorkItem', activeWorkItem);
		const activeSessionObservable = observableValue<IActiveSession | undefined>('activeSession', activeSession as IActiveSession | undefined);
		const createdWorkItemIds: string[] = [];
		const openedSessionIds: string[] = [];
		const openSessionTargets: Array<'object' | 'uri'> = [];
		const preferredSelections: Array<{ workItemId: string; sessionId: string | undefined }> = [];

		instantiationService.stub(IWorkItemService, new class extends mock<IWorkItemService>() {
			override readonly onDidChangeWorkItems = Event.None;
			override readonly activeWorkItem = activeWorkItemObservable;

			override setPreferredSessionForWorkItem(workItemId: string, sessionId: string | undefined): void {
				preferredSelections.push({ workItemId, sessionId });
			}

			override async createSessionForWorkItem(workItemId: string): Promise<ISession> {
				createdWorkItemIds.push(workItemId);
				return createSession(`created-${workItemId}`);
			}
		}());

		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override readonly onDidChangeSessions = Event.None;
			override readonly onDidReplaceSession = Event.None;
			override readonly onDidChangeSessionTypes = Event.None;
			override readonly activeSession = activeSessionObservable;
			override readonly activeProviderId = observableValue('activeProviderId', 'test-provider');

			override async openSession(session: ISession | URI): Promise<void> {
				openSessionTargets.push(URI.isUri(session) ? 'uri' : 'object');
				const nextSession = URI.isUri(session)
					? activeWorkItemObservable.get()?.sessions.get().find(candidate => candidate.resource.toString() === session.toString())
					: session;
				if (nextSession) {
					openedSessionIds.push(nextSession.sessionId);
				}
				activeSessionObservable.set(nextSession as IActiveSession | undefined, undefined);
			}
		}());

		return {
			bar: store.add(instantiationService.createInstance(SessionTabBar, parent)),
			activeWorkItemObservable,
			activeSessionObservable,
			createdWorkItemIds,
			preferredSelections,
			openSessionTargets,
			openedSessionIds,
		};
	}

	test('shows one tab per work-item session when two sessions are present', () => {
		const firstSession = createSession('1');
		const secondSession = createSession('2');
		const workItem = createWorkItem('wi-1', [firstSession, secondSession]);
		const { bar } = createTabBar(workItem, firstSession);

		assert.strictEqual(bar.visible, true);
		assert.strictEqual(parent.querySelectorAll('.session-tab').length, 2);
		assert.deepStrictEqual(
			[...parent.querySelectorAll('.session-tab-title')].map(element => element.textContent),
			['Session 1', 'Session 2']
		);
	});

	test('updates the active tab when the active session changes', () => {
		const firstSession = createSession('1');
		const secondSession = createSession('2');
		const workItem = createWorkItem('wi-2', [firstSession, secondSession]);
		const { activeSessionObservable } = createTabBar(workItem, firstSession);

		const activeTitles = () => [...parent.querySelectorAll('.session-tab.active .session-tab-title')].map(element => element.textContent);

		assert.deepStrictEqual(activeTitles(), ['Session 1']);

		activeSessionObservable.set(secondSession as IActiveSession, undefined);

		assert.deepStrictEqual(activeTitles(), ['Session 2']);
	});

	test('rebinds to the selected work item sessions and keeps tab clicks scoped to that work item', async () => {
		const a1 = createSession('a1');
		const a2 = createSession('a2');
		const b1 = createSession('b1');
		const b2 = createSession('b2');
		const workItemA = createWorkItem('wi-a', [a1, a2]);
		const workItemB = createWorkItem('wi-b', [b1, b2]);
		const { activeWorkItemObservable, activeSessionObservable, openedSessionIds, preferredSelections } = createTabBar(workItemA, a2);

		activeWorkItemObservable.set(workItemB, undefined);
		activeSessionObservable.set(b2 as IActiveSession, undefined);

		assert.deepStrictEqual(
			[...parent.querySelectorAll('.session-tab-title')].map(element => element.textContent),
			['Session b1', 'Session b2']
		);
		assert.deepStrictEqual(
			[...parent.querySelectorAll('.session-tab.active .session-tab-title')].map(element => element.textContent),
			['Session b2']
		);

		const tabs = [...parent.querySelectorAll<HTMLElement>('.session-tab')];
		tabs[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await Promise.resolve();

		assert.deepStrictEqual(preferredSelections, [{ workItemId: 'wi-b', sessionId: 'b1' }]);
		assert.deepStrictEqual(openedSessionIds, ['b1']);
	});

	test('opens the clicked session object so pending tabs can switch immediately', async () => {
		const firstSession = createSession('1');
		const secondSession = createUntitledSession('2');
		const workItem = createWorkItem('wi-3', [firstSession, secondSession]);
		const { openedSessionIds, openSessionTargets, preferredSelections } = createTabBar(workItem, firstSession);

		const tabs = [...parent.querySelectorAll<HTMLElement>('.session-tab')];
		assert.strictEqual(tabs.length, 2);

		tabs[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await Promise.resolve();

		assert.deepStrictEqual(preferredSelections, [{ workItemId: 'wi-3', sessionId: '2' }]);
		assert.deepStrictEqual(openSessionTargets, ['object']);
		assert.deepStrictEqual(openedSessionIds, ['2']);
		assert.deepStrictEqual(
			[...parent.querySelectorAll('.session-tab.active .session-tab-title')].map(element => element.textContent),
			['New Session']
		);
	});

	test('opens restored committed history tabs by resource so the current provider session is resolved', async () => {
		const firstSession = createSession('1');
		const secondSession = createSession('2');
		const workItem = createWorkItem('wi-restore', [firstSession, secondSession]);
		const { openSessionTargets, openedSessionIds, preferredSelections } = createTabBar(workItem, firstSession);

		const tabs = [...parent.querySelectorAll<HTMLElement>('.session-tab')];
		assert.strictEqual(tabs.length, 2);

		tabs[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await Promise.resolve();

		assert.deepStrictEqual(preferredSelections, [{ workItemId: 'wi-restore', sessionId: '2' }]);
		assert.deepStrictEqual(openSessionTargets, ['uri']);
		assert.deepStrictEqual(openedSessionIds, ['2']);
	});

	test('falls back to New Session when the session title is empty', () => {
		const firstSession = createUntitledSession('1');
		const secondSession = createSession('2');
		const workItem = createWorkItem('wi-4', [firstSession, secondSession]);
		createTabBar(workItem, firstSession);

		assert.deepStrictEqual(
			[...parent.querySelectorAll('.session-tab-title')].map(element => element.textContent),
			['New Session', 'Session 2']
		);
	});

	test('creates a new session for the active work item from the add button', async () => {
		const firstSession = createSession('1');
		const secondSession = createSession('2');
		const workItem = createWorkItem('wi-5', [firstSession, secondSession]);
		const { createdWorkItemIds } = createTabBar(workItem, firstSession);

		const addButton = parent.querySelector('.session-tab-add');
		assert.ok(addButton);

		addButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await Promise.resolve();

		assert.deepStrictEqual(createdWorkItemIds, ['wi-5']);
	});

	test('becomes visible when the real WorkItemService adds a second pending session', async () => {
		const instantiationService = store.add(new TestInstantiationService());
		const sessions: ISession[] = [];
		const pendingSessions = [createUntitledSession('pending-2')];
		const activeSessionObservable = observableValue<IActiveSession | undefined>('activeSession', undefined);

		instantiationService.stub(IStorageService, store.add(new InMemoryStorageService()));
		instantiationService.stub(IContextKeyService, new MockContextKeyService());
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override readonly onDidChangeSessions = Event.None;
			override readonly onDidReplaceSession = Event.None;
			override readonly onDidChangeSessionTypes = Event.None;
			override readonly activeSession = activeSessionObservable;
			override readonly activeProviderId = observableValue('activeProviderId', 'test-provider');

			override getSessions(): ISession[] {
				return [...sessions];
			}

			override createNewSession(_providerId: string, _workspaceUri: URI, _sessionTypeId?: string, onBeforeActivate?: (session: ISession) => void): ISession {
				const session = pendingSessions.shift();
				assert.ok(session);
				onBeforeActivate?.(session);
				activeSessionObservable.set(session as IActiveSession, undefined);
				return session;
			}

			override async openSession(session: ISession | URI): Promise<void> {
				const nextSession = URI.isUri(session)
					? sessions.find(candidate => candidate.resource.toString() === session.toString())
					: session;
				activeSessionObservable.set(nextSession as IActiveSession | undefined, undefined);
			}
		}());

		const workItemService = store.add(instantiationService.createInstance(WorkItemService));
		instantiationService.stub(IWorkItemService, workItemService);

		const firstSession = createSession('1');
		sessions.push(firstSession);

		const workItem = workItemService.createWorkItem({ title: 'Investigate visibility' });
		workItemService.addSession(workItem.id, firstSession.sessionId);
		workItemService.setActiveWorkItem(workItem.id);

		const bar = store.add(instantiationService.createInstance(SessionTabBar, parent));
		assert.strictEqual(bar.visible, false);

		await workItemService.createSessionForWorkItem(workItem.id);

		assert.strictEqual(bar.visible, true);
		assert.deepStrictEqual(
			[...parent.querySelectorAll('.session-tab-title')].map(element => element.textContent),
			['Session 1', 'New Session']
		);
	});

	test('marks the newly created session as the active tab when adding via the WorkItemService', async () => {
		const instantiationService = store.add(new TestInstantiationService());
		const sessions: ISession[] = [];
		const pendingSessions = [createUntitledSession('pending-2')];
		const activeSessionObservable = observableValue<IActiveSession | undefined>('activeSession', undefined);

		instantiationService.stub(IStorageService, store.add(new InMemoryStorageService()));
		instantiationService.stub(IContextKeyService, new MockContextKeyService());
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override readonly onDidChangeSessions = Event.None;
			override readonly onDidReplaceSession = Event.None;
			override readonly onDidChangeSessionTypes = Event.None;
			override readonly activeSession = activeSessionObservable;
			override readonly activeProviderId = observableValue('activeProviderId', 'test-provider');

			override getSessions(): ISession[] {
				return [...sessions];
			}

			override createNewSession(_providerId: string, _workspaceUri: URI, _sessionTypeId?: string, onBeforeActivate?: (session: ISession) => void): ISession {
				const session = pendingSessions.shift();
				assert.ok(session);
				onBeforeActivate?.(session);
				activeSessionObservable.set(session as IActiveSession, undefined);
				return session;
			}

			override async openSession(session: ISession | URI): Promise<void> {
				const nextSession = URI.isUri(session)
					? sessions.find(candidate => candidate.resource.toString() === session.toString())
					: session;
				activeSessionObservable.set(nextSession as IActiveSession | undefined, undefined);
			}
		}());

		const workItemService = store.add(instantiationService.createInstance(WorkItemService));
		instantiationService.stub(IWorkItemService, workItemService);

		const firstSession = createSession('1');
		sessions.push(firstSession);

		const workItem = workItemService.createWorkItem({ title: 'Active tab regression' });
		workItemService.addSession(workItem.id, firstSession.sessionId);
		workItemService.setActiveWorkItem(workItem.id);
		activeSessionObservable.set(firstSession as IActiveSession, undefined);

		const bar = store.add(instantiationService.createInstance(SessionTabBar, parent));
		await workItemService.createSessionForWorkItem(workItem.id);

		const activeTabs = [...parent.querySelectorAll('.session-tab.active .session-tab-title')]
			.map(element => element.textContent);
		assert.strictEqual(bar.visible, true);
		assert.deepStrictEqual(activeTabs, ['New Session']);
	});
});
