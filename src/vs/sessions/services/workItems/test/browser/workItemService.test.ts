/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { InMemoryStorageService, IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IsNewChatSessionContext } from '../../../../common/contextkeys.js';
import { ISession, SessionStatus } from '../../../sessions/common/session.js';
import { IActiveSession, ISessionReplaceEvent, ISessionsChangeEvent, ISessionsManagementService } from '../../../sessions/common/sessionsManagement.js';
import { WorkItemService } from '../../browser/workItemService.js';

function createSession(id: string, options?: { providerId?: string; resource?: URI; workspaceUri?: URI; createdAt?: Date; title?: string }): IActiveSession {
	const resource = options?.resource ?? URI.parse(`vscode-agent-session:/${id}`);
	const providerId = options?.providerId ?? 'test-provider';
	const createdAt = options?.createdAt ?? new Date();
	const chat = {
		resource,
		createdAt,
		title: observableValue(`chat.title.${id}`, options?.title ?? id),
		updatedAt: observableValue(`chat.updatedAt.${id}`, new Date()),
		status: observableValue(`chat.status.${id}`, SessionStatus.Untitled),
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
		providerId,
		sessionType: 'background',
		icon: Codicon.copilot,
		createdAt: chat.createdAt,
		workspace: observableValue(`session.workspace.${id}`, options?.workspaceUri ? {
			label: 'repo',
			icon: Codicon.folder,
			repositories: [{
				uri: options.workspaceUri,
				workingDirectory: options.workspaceUri,
				detail: undefined,
				baseBranchName: undefined,
				baseBranchProtected: undefined,
			}],
			requiresWorkspaceTrust: false,
		} : undefined),
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
		chats: observableValue(`session.chats.${id}`, [chat]),
		mainChat: chat,
		activeChat: observableValue(`session.activeChat.${id}`, chat),
		capabilities: { supportsMultipleChats: false },
	};
}

suite('WorkItemService', () => {
	const disposables = new DisposableStore();

	teardown(() => {
		disposables.clear();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	test('preserves all work item sessions when temporary sessions are replaced', () => {
		const instantiationService = disposables.add(new TestInstantiationService());
		const sessionsChanged = disposables.add(new Emitter<ISessionsChangeEvent>());
		const sessionReplaced = disposables.add(new Emitter<ISessionReplaceEvent>());
		const sessions: ISession[] = [];

		instantiationService.stub(IStorageService, disposables.add(new InMemoryStorageService()));
		instantiationService.stub(IContextKeyService, new MockContextKeyService());
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override readonly onDidChangeSessions = sessionsChanged.event;
			override readonly onDidReplaceSession = sessionReplaced.event;
			override readonly activeSession = observableValue<IActiveSession | undefined>('activeSession', undefined);
			override readonly activeProviderId = observableValue('activeProviderId', 'test-provider');

			override getSessions(): ISession[] {
				return [...sessions];
			}

			override async openSession(): Promise<void> { }
			override setActiveProvider(): void { }
		}());

		const service = disposables.add(instantiationService.createInstance(WorkItemService));
		const workItem = service.createWorkItem({ title: 'Investigate sessions' });

		const firstTemp = createSession('temp-1');
		sessions.push(firstTemp);
		service.addSession(workItem.id, firstTemp.sessionId);

		const firstCommitted = createSession('committed-1');
		const firstIndex = sessions.findIndex(session => session.sessionId === firstTemp.sessionId);
		assert.notStrictEqual(firstIndex, -1);
		sessions.splice(firstIndex, 1, firstCommitted);
		sessionReplaced.fire({ from: firstTemp, to: firstCommitted });

		const secondTemp = createSession('temp-2');
		sessions.push(secondTemp);
		service.addSession(workItem.id, secondTemp.sessionId);

		const secondCommitted = createSession('committed-2');
		const secondIndex = sessions.findIndex(session => session.sessionId === secondTemp.sessionId);
		assert.notStrictEqual(secondIndex, -1);
		sessions.splice(secondIndex, 1, secondCommitted);
		sessionReplaced.fire({ from: secondTemp, to: secondCommitted });

		const resolvedWorkItem = service.getWorkItem(workItem.id);
		assert.ok(resolvedWorkItem);
		assert.deepStrictEqual(
			resolvedWorkItem.sessions.get().map(session => session.sessionId),
			['committed-1', 'committed-2']
		);
	});

	test('keeps a newly created pending session visible for the work item before the provider publishes it', async () => {
		const instantiationService = disposables.add(new TestInstantiationService());
		const sessionsChanged = disposables.add(new Emitter<ISessionsChangeEvent>());
		const sessionReplaced = disposables.add(new Emitter<ISessionReplaceEvent>());
		const sessions: ISession[] = [];
		const pendingSession = createSession('temp-2');

		instantiationService.stub(IStorageService, disposables.add(new InMemoryStorageService()));
		instantiationService.stub(IContextKeyService, new MockContextKeyService());
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override readonly onDidChangeSessions = sessionsChanged.event;
			override readonly onDidReplaceSession = sessionReplaced.event;
			override readonly activeSession = observableValue<IActiveSession | undefined>('activeSession', undefined);
			override readonly activeProviderId = observableValue('activeProviderId', 'test-provider');

			override getSessions(): ISession[] {
				return [...sessions];
			}

			override createNewSession(_providerId: string, _workspaceUri: URI, _sessionTypeId?: string, onBeforeActivate?: (session: ISession) => void): ISession {
				onBeforeActivate?.(pendingSession);
				return pendingSession;
			}

			override async openSession(): Promise<void> { }
			override setActiveProvider(): void { }
		}());

		const service = disposables.add(instantiationService.createInstance(WorkItemService));
		const workItem = service.createWorkItem({ title: 'Investigate pending sessions' });

		const committedSession = createSession('committed-1');
		sessions.push(committedSession);
		service.addSession(workItem.id, committedSession.sessionId);

		await service.createSessionForWorkItem(workItem.id);

		const resolvedWorkItem = service.getWorkItem(workItem.id);
		assert.ok(resolvedWorkItem);
		assert.deepStrictEqual(
			resolvedWorkItem.sessions.get().map(session => session.sessionId),
			['committed-1', 'temp-2']
		);
	});

	test('setActiveWorkItem opens the resolved session object for the latest work item session', () => {
		const instantiationService = disposables.add(new TestInstantiationService());
		const sessionsChanged = disposables.add(new Emitter<ISessionsChangeEvent>());
		const sessionReplaced = disposables.add(new Emitter<ISessionReplaceEvent>());
		const sessions: ISession[] = [];
		const openedSessions: ISession[] = [];
		const activeSession = observableValue<IActiveSession | undefined>('activeSession', undefined);

		instantiationService.stub(IStorageService, disposables.add(new InMemoryStorageService()));
		instantiationService.stub(IContextKeyService, new MockContextKeyService());
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override readonly onDidChangeSessions = sessionsChanged.event;
			override readonly onDidReplaceSession = sessionReplaced.event;
			override readonly activeSession = activeSession;
			override readonly activeProviderId = observableValue('activeProviderId', 'test-provider');

			override getSessions(): ISession[] {
				return [...sessions];
			}

			override async openSession(session: ISession): Promise<void> {
				openedSessions.push(session);
				activeSession.set(session as IActiveSession, undefined);
			}

			override setActiveProvider(): void { }
		}());

		const service = disposables.add(instantiationService.createInstance(WorkItemService));
		const workItem = service.createWorkItem({ title: 'Investigate activation' });
		const firstSession = createSession('committed-1');
		const secondSession = createSession('committed-2');

		sessions.push(firstSession, secondSession);
		service.addSession(workItem.id, firstSession.sessionId);
		service.addSession(workItem.id, secondSession.sessionId);

		service.setActiveWorkItem(workItem.id);

		assert.deepStrictEqual(openedSessions, [secondSession]);
	});

	test('createSessionForWorkItem replaces an existing untitled pending session on the active work item', async () => {
		const instantiationService = disposables.add(new TestInstantiationService());
		const sessionsChanged = disposables.add(new Emitter<ISessionsChangeEvent>());
		const sessionReplaced = disposables.add(new Emitter<ISessionReplaceEvent>());
		const sessions: ISession[] = [];
		const pendingSessions = [createSession('temp-2'), createSession('temp-3')];

		instantiationService.stub(IStorageService, disposables.add(new InMemoryStorageService()));
		instantiationService.stub(IContextKeyService, new MockContextKeyService());
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override readonly onDidChangeSessions = sessionsChanged.event;
			override readonly onDidReplaceSession = sessionReplaced.event;
			override readonly activeSession = observableValue<IActiveSession | undefined>('activeSession', undefined);
			override readonly activeProviderId = observableValue('activeProviderId', 'test-provider');

			override getSessions(): ISession[] {
				return [...sessions];
			}

			override createNewSession(_providerId: string, _workspaceUri: URI, _sessionTypeId?: string, onBeforeActivate?: (session: ISession) => void): ISession {
				const session = pendingSessions.shift();
				assert.ok(session);
				onBeforeActivate?.(session);
				return session;
			}

			override async openSession(): Promise<void> { }
			override setActiveProvider(): void { }
		}());

		const service = disposables.add(instantiationService.createInstance(WorkItemService));
		const workItem = service.createWorkItem({ title: 'Investigate repeated pending sessions' });

		const committedSession = createSession('committed-1');
		sessions.push(committedSession);
		service.addSession(workItem.id, committedSession.sessionId);

		await service.createSessionForWorkItem(workItem.id);
		await service.createSessionForWorkItem(workItem.id);

		const resolvedWorkItem = service.getWorkItem(workItem.id);
		assert.ok(resolvedWorkItem);
		// The previous untitled pending session (temp-2) is replaced by the
		// new one (temp-3) so the SessionTabBar does not accumulate ghost
		// tabs for sessions that the provider already disposed.
		assert.deepStrictEqual(
			resolvedWorkItem.sessions.get().map(session => session.sessionId),
			['committed-1', 'temp-3']
		);
	});

	test('restored active work items reopen their latest resolved session once provider sessions load', () => {
		const storageService = disposables.add(new InMemoryStorageService());
		storageService.store('workItems.data', JSON.stringify([{
			id: 'work-item-1',
			title: 'Restore Me',
			description: '',
			status: 'open',
			priority: 'backlog',
			labels: [],
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			sessionIds: ['committed-1', 'committed-2'],
		}]), StorageScope.PROFILE, StorageTarget.USER);
		storageService.store('workItems.activeId', 'work-item-1', StorageScope.PROFILE, StorageTarget.USER);

		const instantiationService = disposables.add(new TestInstantiationService());
		const sessionsChanged = disposables.add(new Emitter<ISessionsChangeEvent>());
		const sessionReplaced = disposables.add(new Emitter<ISessionReplaceEvent>());
		const sessions: ISession[] = [];
		const openedSessions: ISession[] = [];
		const activeSession = observableValue<IActiveSession | undefined>('activeSession', undefined);

		instantiationService.stub(IStorageService, storageService);
		instantiationService.stub(IContextKeyService, new MockContextKeyService());
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override readonly onDidChangeSessions = sessionsChanged.event;
			override readonly onDidReplaceSession = sessionReplaced.event;
			override readonly activeSession = activeSession;
			override readonly activeProviderId = observableValue('activeProviderId', 'test-provider');

			override getSessions(): ISession[] {
				return [...sessions];
			}

			override async openSession(session: ISession): Promise<void> {
				openedSessions.push(session);
				activeSession.set(session as IActiveSession, undefined);
			}

			override setActiveProvider(): void { }
		}());

		const service = disposables.add(instantiationService.createInstance(WorkItemService));
		const restoredWorkItem = service.getWorkItem('work-item-1');
		assert.ok(restoredWorkItem);
		assert.strictEqual(service.activeWorkItem.get()?.id, 'work-item-1');
		assert.deepStrictEqual(restoredWorkItem.sessions.get(), []);

		const firstSession = createSession('committed-1', { title: 'Older Session' });
		const secondSession = createSession('committed-2', { title: 'Latest Session' });
		sessions.push(firstSession, secondSession);
		sessionsChanged.fire({ added: [firstSession, secondSession], removed: [], changed: [] });

		assert.deepStrictEqual(openedSessions, [secondSession]);
		assert.deepStrictEqual(
			restoredWorkItem.sessions.get().map(session => session.sessionId),
			['committed-1', 'committed-2']
		);
	});

	test('restored active work items realign if startup later restores an unrelated active session', () => {
		const storageService = disposables.add(new InMemoryStorageService());
		storageService.store('workItems.data', JSON.stringify([{
			id: 'work-item-1',
			title: 'Restore Me',
			description: '',
			status: 'open',
			priority: 'backlog',
			labels: [],
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			sessionIds: ['committed-1', 'committed-2'],
		}]), StorageScope.PROFILE, StorageTarget.USER);
		storageService.store('workItems.activeId', 'work-item-1', StorageScope.PROFILE, StorageTarget.USER);

		const instantiationService = disposables.add(new TestInstantiationService());
		const sessionsChanged = disposables.add(new Emitter<ISessionsChangeEvent>());
		const sessionReplaced = disposables.add(new Emitter<ISessionReplaceEvent>());
		const sessions: ISession[] = [];
		const openedSessions: ISession[] = [];
		const activeSession = observableValue<IActiveSession | undefined>('activeSession', undefined);
		const contextKeyService = new MockContextKeyService();

		instantiationService.stub(IStorageService, storageService);
		instantiationService.stub(IContextKeyService, contextKeyService);
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override readonly onDidChangeSessions = sessionsChanged.event;
			override readonly onDidReplaceSession = sessionReplaced.event;
			override readonly activeSession = activeSession;
			override readonly activeProviderId = observableValue('activeProviderId', 'test-provider');

			override getSessions(): ISession[] {
				return [...sessions];
			}

			override async openSession(session: ISession): Promise<void> {
				openedSessions.push(session);
				activeSession.set(session as IActiveSession, undefined);
			}

			override setActiveProvider(): void { }
		}());

		const service = disposables.add(instantiationService.createInstance(WorkItemService));
		const restoredWorkItem = service.getWorkItem('work-item-1');
		assert.ok(restoredWorkItem);

		const firstSession = createSession('committed-1');
		const secondSession = createSession('committed-2');
		const unrelatedSession = createSession('unrelated');
		sessions.push(firstSession, secondSession, unrelatedSession);
		sessionsChanged.fire({ added: [firstSession, secondSession, unrelatedSession], removed: [], changed: [] });

		assert.deepStrictEqual(openedSessions, [secondSession]);

		activeSession.set(unrelatedSession, undefined);

		assert.deepStrictEqual(openedSessions, [secondSession, secondSession]);
	});

	test('does not override the new session view while a work item remains selected', () => {
		const instantiationService = disposables.add(new TestInstantiationService());
		const sessionsChanged = disposables.add(new Emitter<ISessionsChangeEvent>());
		const sessionReplaced = disposables.add(new Emitter<ISessionReplaceEvent>());
		const sessions: ISession[] = [];
		const openedSessions: ISession[] = [];
		const activeSession = observableValue<IActiveSession | undefined>('activeSession', undefined);
		const contextKeyService = new MockContextKeyService();

		instantiationService.stub(IStorageService, disposables.add(new InMemoryStorageService()));
		instantiationService.stub(IContextKeyService, contextKeyService);
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override readonly onDidChangeSessions = sessionsChanged.event;
			override readonly onDidReplaceSession = sessionReplaced.event;
			override readonly activeSession = activeSession;
			override readonly activeProviderId = observableValue('activeProviderId', 'test-provider');

			override getSessions(): ISession[] {
				return [...sessions];
			}

			override async openSession(session: ISession): Promise<void> {
				openedSessions.push(session);
				activeSession.set(session as IActiveSession, undefined);
			}

			override setActiveProvider(): void { }
		}());

		const service = disposables.add(instantiationService.createInstance(WorkItemService));
		const workItem = service.createWorkItem({ title: 'Keep New Session Open' });
		const firstSession = createSession('committed-1');
		const secondSession = createSession('committed-2');
		sessions.push(firstSession, secondSession);
		service.addSession(workItem.id, firstSession.sessionId);
		service.addSession(workItem.id, secondSession.sessionId);
		service.setActiveWorkItem(workItem.id);

		assert.deepStrictEqual(openedSessions, [secondSession]);

		const isNewChatSessionContext = IsNewChatSessionContext.bindTo(contextKeyService);
		isNewChatSessionContext.set(true);
		openedSessions.length = 0;
		activeSession.set(undefined, undefined);

		assert.deepStrictEqual(openedSessions, []);
	});

	test('realigns to the directly selected history session instead of reverting to the latest session', () => {
		const instantiationService = disposables.add(new TestInstantiationService());
		const sessionsChanged = disposables.add(new Emitter<ISessionsChangeEvent>());
		const sessionReplaced = disposables.add(new Emitter<ISessionReplaceEvent>());
		const sessions: ISession[] = [];
		const openedSessions: ISession[] = [];
		const activeSession = observableValue<IActiveSession | undefined>('activeSession', undefined);

		instantiationService.stub(IStorageService, disposables.add(new InMemoryStorageService()));
		instantiationService.stub(IContextKeyService, new MockContextKeyService());
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override readonly onDidChangeSessions = sessionsChanged.event;
			override readonly onDidReplaceSession = sessionReplaced.event;
			override readonly activeSession = activeSession;
			override readonly activeProviderId = observableValue('activeProviderId', 'test-provider');

			override getSessions(): ISession[] {
				return [...sessions];
			}

			override async openSession(session: ISession): Promise<void> {
				openedSessions.push(session);
				activeSession.set(session as IActiveSession, undefined);
			}

			override setActiveProvider(): void { }
		}());

		const service = disposables.add(instantiationService.createInstance(WorkItemService));
		const workItem = service.createWorkItem({ title: 'Inspect history' });
		const firstSession = createSession('committed-1');
		const secondSession = createSession('committed-2');
		const unrelatedSession = createSession('unrelated');

		sessions.push(firstSession, secondSession, unrelatedSession);
		service.addSession(workItem.id, firstSession.sessionId);
		service.addSession(workItem.id, secondSession.sessionId);
		service.setActiveWorkItem(workItem.id);

		assert.deepStrictEqual(openedSessions, [secondSession]);

		activeSession.set(firstSession, undefined);
		activeSession.set(unrelatedSession, undefined);

		assert.deepStrictEqual(openedSessions, [secondSession, firstSession]);
	});

	test('restores each work item to its own preferred history session when switching across work items', () => {
		const instantiationService = disposables.add(new TestInstantiationService());
		const sessionsChanged = disposables.add(new Emitter<ISessionsChangeEvent>());
		const sessionReplaced = disposables.add(new Emitter<ISessionReplaceEvent>());
		const sessions: ISession[] = [];
		const openedSessions: ISession[] = [];
		const activeSession = observableValue<IActiveSession | undefined>('activeSession', undefined);

		instantiationService.stub(IStorageService, disposables.add(new InMemoryStorageService()));
		instantiationService.stub(IContextKeyService, new MockContextKeyService());
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override readonly onDidChangeSessions = sessionsChanged.event;
			override readonly onDidReplaceSession = sessionReplaced.event;
			override readonly activeSession = activeSession;
			override readonly activeProviderId = observableValue('activeProviderId', 'test-provider');

			override getSessions(): ISession[] {
				return [...sessions];
			}

			override async openSession(session: ISession): Promise<void> {
				openedSessions.push(session);
				activeSession.set(session as IActiveSession, undefined);
			}

			override setActiveProvider(): void { }
		}());

		const service = disposables.add(instantiationService.createInstance(WorkItemService));
		const workItemA = service.createWorkItem({ title: 'Benchmark analysis' });
		const workItemB = service.createWorkItem({ title: 'Java upgrade plugin' });
		const a1 = createSession('a-1');
		const a2 = createSession('a-2');
		const b1 = createSession('b-1');
		const b2 = createSession('b-2');

		sessions.push(a1, a2, b1, b2);
		service.addSession(workItemA.id, a1.sessionId);
		service.addSession(workItemA.id, a2.sessionId);
		service.addSession(workItemB.id, b1.sessionId);
		service.addSession(workItemB.id, b2.sessionId);

		service.setActiveWorkItem(workItemA.id);
		assert.deepStrictEqual(openedSessions.map(session => session.sessionId), ['a-2']);

		service.setPreferredSessionForWorkItem(workItemA.id, a1.sessionId);
		service.setActiveWorkItem(workItemB.id);
		assert.deepStrictEqual(openedSessions.map(session => session.sessionId), ['a-2', 'b-2']);

		service.setPreferredSessionForWorkItem(workItemB.id, b1.sessionId);
		service.setActiveWorkItem(workItemA.id);
		service.setActiveWorkItem(workItemB.id);

		assert.deepStrictEqual(openedSessions.map(session => session.sessionId), ['a-2', 'b-2', 'a-1', 'b-1']);
	});

	test('keeps a directly opened persisted history session on the active work item before a sessions refresh arrives', () => {
		const storageService = disposables.add(new InMemoryStorageService());
		storageService.store('workItems.data', JSON.stringify([{
			id: 'work-item-1',
			title: 'Restore Me',
			description: '',
			status: 'open',
			priority: 'backlog',
			labels: [],
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			sessionIds: ['committed-1', 'committed-2'],
			activeSessionId: 'committed-1',
		}]), StorageScope.PROFILE, StorageTarget.USER);
		storageService.store('workItems.activeId', 'work-item-1', StorageScope.PROFILE, StorageTarget.USER);

		const instantiationService = disposables.add(new TestInstantiationService());
		const sessionsChanged = disposables.add(new Emitter<ISessionsChangeEvent>());
		const sessionReplaced = disposables.add(new Emitter<ISessionReplaceEvent>());
		const sessions: ISession[] = [];
		const openedSessions: ISession[] = [];
		const activeSession = observableValue<IActiveSession | undefined>('activeSession', undefined);

		instantiationService.stub(IStorageService, storageService);
		instantiationService.stub(IContextKeyService, new MockContextKeyService());
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override readonly onDidChangeSessions = sessionsChanged.event;
			override readonly onDidReplaceSession = sessionReplaced.event;
			override readonly activeSession = activeSession;
			override readonly activeProviderId = observableValue('activeProviderId', 'test-provider');

			override getSessions(): ISession[] {
				return [...sessions];
			}

			override async openSession(session: ISession): Promise<void> {
				openedSessions.push(session);
				activeSession.set(session as IActiveSession, undefined);
			}

			override setActiveProvider(): void { }
		}());

		const service = disposables.add(instantiationService.createInstance(WorkItemService));
		const firstSession = createSession('committed-1');
		sessions.push(firstSession);
		sessionsChanged.fire({ added: [firstSession], removed: [], changed: [] });

		assert.deepStrictEqual(openedSessions, [firstSession]);
		assert.deepStrictEqual(service.getWorkItem('work-item-1')?.sessions.get().map(session => session.sessionId), ['committed-1']);

		const secondSession = createSession('committed-2');
		sessions.push(secondSession);
		activeSession.set(secondSession, undefined);

		assert.deepStrictEqual(service.getWorkItem('work-item-1')?.sessions.get().map(session => session.sessionId), ['committed-1', 'committed-2']);
		assert.deepStrictEqual(openedSessions, [firstSession]);
	});

	test('restores the persisted work-item history session before falling back to the latest session', () => {
		const storageService = disposables.add(new InMemoryStorageService());
		storageService.store('workItems.data', JSON.stringify([{
			id: 'work-item-1',
			title: 'Restore Me',
			description: '',
			status: 'open',
			priority: 'backlog',
			labels: [],
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			sessionIds: ['committed-1', 'committed-2'],
			activeSessionId: 'committed-1',
		}]), StorageScope.PROFILE, StorageTarget.USER);
		storageService.store('workItems.activeId', 'work-item-1', StorageScope.PROFILE, StorageTarget.USER);

		const instantiationService = disposables.add(new TestInstantiationService());
		const sessionsChanged = disposables.add(new Emitter<ISessionsChangeEvent>());
		const sessionReplaced = disposables.add(new Emitter<ISessionReplaceEvent>());
		const sessions: ISession[] = [];
		const openedSessions: ISession[] = [];
		const activeSession = observableValue<IActiveSession | undefined>('activeSession', undefined);

		instantiationService.stub(IStorageService, storageService);
		instantiationService.stub(IContextKeyService, new MockContextKeyService());
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override readonly onDidChangeSessions = sessionsChanged.event;
			override readonly onDidReplaceSession = sessionReplaced.event;
			override readonly activeSession = activeSession;
			override readonly activeProviderId = observableValue('activeProviderId', 'test-provider');

			override getSessions(): ISession[] {
				return [...sessions];
			}

			override async openSession(session: ISession): Promise<void> {
				openedSessions.push(session);
				activeSession.set(session as IActiveSession, undefined);
			}

			override setActiveProvider(): void { }
		}());

		disposables.add(instantiationService.createInstance(WorkItemService));

		const firstSession = createSession('committed-1');
		const secondSession = createSession('committed-2');
		sessions.push(firstSession, secondSession);
		sessionsChanged.fire({ added: [firstSession, secondSession], removed: [], changed: [] });

		assert.deepStrictEqual(openedSessions, [firstSession]);
	});

	test('reconciles legacy untitled work-item session ids with a directly opened committed history session in the same workspace', () => {
		const storageService = disposables.add(new InMemoryStorageService());
		storageService.store('workItems.data', JSON.stringify([{
			id: 'work-item-1',
			title: 'Benchmark analysis',
			description: '',
			status: 'open',
			priority: 'focus',
			labels: [],
			workingDirectory: 'file:///workspace/msbench-logs',
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			sessionIds: [
				'default-copilot:copilotcli:/untitled-1',
				'default-copilot:copilotcli:/untitled-2',
			],
		}]), StorageScope.PROFILE, StorageTarget.USER);
		storageService.store('workItems.activeId', 'work-item-1', StorageScope.PROFILE, StorageTarget.USER);

		const instantiationService = disposables.add(new TestInstantiationService());
		const sessionsChanged = disposables.add(new Emitter<ISessionsChangeEvent>());
		const sessionReplaced = disposables.add(new Emitter<ISessionReplaceEvent>());
		const sessions: ISession[] = [];
		const activeSession = observableValue<IActiveSession | undefined>('activeSession', undefined);

		instantiationService.stub(IStorageService, storageService);
		instantiationService.stub(IContextKeyService, new MockContextKeyService());
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override readonly onDidChangeSessions = sessionsChanged.event;
			override readonly onDidReplaceSession = sessionReplaced.event;
			override readonly activeSession = activeSession;
			override readonly activeProviderId = observableValue('activeProviderId', 'default-copilot');

			override getSessions(): ISession[] {
				return [...sessions];
			}

			override async openSession(): Promise<void> { }
			override setActiveProvider(): void { }
		}());

		const service = disposables.add(instantiationService.createInstance(WorkItemService));
		const committedSession = createSession('default-copilot:copilotcli:/37e8d2ef-7075-43fd-883f-b7bbb05a370c', {
			providerId: 'default-copilot',
			resource: URI.parse('copilotcli:/37e8d2ef-7075-43fd-883f-b7bbb05a370c'),
			workspaceUri: URI.parse('file:///workspace/msbench-logs'),
		});
		sessions.push(committedSession);
		activeSession.set(committedSession, undefined);

		assert.deepStrictEqual(service.getWorkItem('work-item-1')?.sessions.get().map(session => session.sessionId), [committedSession.sessionId]);

		const storedWorkItems = JSON.parse(storageService.get('workItems.data', StorageScope.PROFILE) ?? '[]');
		assert.deepStrictEqual(storedWorkItems[0].sessionIds, [
			committedSession.sessionId,
			'default-copilot:copilotcli:/untitled-2',
		]);
		assert.strictEqual(storedWorkItems[0].activeSessionId, committedSession.sessionId);
	});

	test('eagerly restores all persisted work-item histories from legacy untitled ids after relaunch', () => {
		const storageService = disposables.add(new InMemoryStorageService());
		storageService.store('workItems.data', JSON.stringify([{
			id: 'work-item-1',
			title: 'Benchmark analysis',
			description: '',
			status: 'open',
			priority: 'focus',
			labels: [],
			workingDirectory: 'file:///workspace/msbench-logs',
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			sessionIds: [
				'default-copilot:copilotcli:/untitled-1',
				'default-copilot:copilotcli:/untitled-2',
			],
			activeSessionId: 'default-copilot:copilotcli:/untitled-2',
		}]), StorageScope.PROFILE, StorageTarget.USER);
		storageService.store('workItems.activeId', 'work-item-1', StorageScope.PROFILE, StorageTarget.USER);

		const instantiationService = disposables.add(new TestInstantiationService());
		const sessionsChanged = disposables.add(new Emitter<ISessionsChangeEvent>());
		const sessionReplaced = disposables.add(new Emitter<ISessionReplaceEvent>());
		const sessions: ISession[] = [];
		const openedSessions: ISession[] = [];
		const activeSession = observableValue<IActiveSession | undefined>('activeSession', undefined);

		instantiationService.stub(IStorageService, storageService);
		instantiationService.stub(IContextKeyService, new MockContextKeyService());
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override readonly onDidChangeSessions = sessionsChanged.event;
			override readonly onDidReplaceSession = sessionReplaced.event;
			override readonly activeSession = activeSession;
			override readonly activeProviderId = observableValue('activeProviderId', 'default-copilot');

			override getSessions(): ISession[] {
				return [...sessions];
			}

			override async openSession(session: ISession): Promise<void> {
				openedSessions.push(session);
				activeSession.set(session as IActiveSession, undefined);
			}

			override setActiveProvider(): void { }
		}());

		const service = disposables.add(instantiationService.createInstance(WorkItemService));
		const firstCommitted = createSession('default-copilot:copilotcli:/history-1', {
			providerId: 'default-copilot',
			resource: URI.parse('copilotcli:/history-1'),
			workspaceUri: URI.parse('file:///workspace/msbench-logs'),
		});
		const secondCommitted = createSession('default-copilot:copilotcli:/history-2', {
			providerId: 'default-copilot',
			resource: URI.parse('copilotcli:/history-2'),
			workspaceUri: URI.parse('file:///workspace/msbench-logs'),
		});
		sessions.push(firstCommitted, secondCommitted);
		sessionsChanged.fire({ added: [firstCommitted, secondCommitted], removed: [], changed: [] });

		assert.deepStrictEqual(service.getWorkItem('work-item-1')?.sessions.get().map(session => session.sessionId), [
			firstCommitted.sessionId,
			secondCommitted.sessionId,
		]);
		assert.deepStrictEqual(openedSessions, [secondCommitted]);

		const storedWorkItems = JSON.parse(storageService.get('workItems.data', StorageScope.PROFILE) ?? '[]');
		assert.deepStrictEqual(storedWorkItems[0].sessionIds, [
			firstCommitted.sessionId,
			secondCommitted.sessionId,
		]);
		assert.strictEqual(storedWorkItems[0].activeSessionId, secondCommitted.sessionId);
	});

	test('eagerly restores the preferred persisted history when multiple committed candidates share the same provider and workspace', () => {
		const storageService = disposables.add(new InMemoryStorageService());
		storageService.store('workItems.data', JSON.stringify([{
			id: 'work-item-1',
			title: 'Benchmark analysis',
			description: '',
			status: 'open',
			priority: 'focus',
			labels: [],
			workingDirectory: 'file:///workspace/msbench-logs',
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			sessionIds: [
				'default-copilot:copilotcli:/untitled-1',
				'default-copilot:copilotcli:/untitled-2',
			],
			activeSessionId: 'default-copilot:copilotcli:/untitled-2',
		}]), StorageScope.PROFILE, StorageTarget.USER);
		storageService.store('workItems.activeId', 'work-item-1', StorageScope.PROFILE, StorageTarget.USER);

		const instantiationService = disposables.add(new TestInstantiationService());
		const sessionsChanged = disposables.add(new Emitter<ISessionsChangeEvent>());
		const sessionReplaced = disposables.add(new Emitter<ISessionReplaceEvent>());
		const sessions: ISession[] = [];
		const openedSessions: ISession[] = [];
		const activeSession = observableValue<IActiveSession | undefined>('activeSession', undefined);

		instantiationService.stub(IStorageService, storageService);
		instantiationService.stub(IContextKeyService, new MockContextKeyService());
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override readonly onDidChangeSessions = sessionsChanged.event;
			override readonly onDidReplaceSession = sessionReplaced.event;
			override readonly activeSession = activeSession;
			override readonly activeProviderId = observableValue('activeProviderId', 'default-copilot');

			override getSessions(): ISession[] {
				return [...sessions];
			}

			override async openSession(session: ISession): Promise<void> {
				openedSessions.push(session);
				activeSession.set(session as IActiveSession, undefined);
			}

			override setActiveProvider(): void { }
		}());

		const service = disposables.add(instantiationService.createInstance(WorkItemService));
		const firstCommitted = createSession('default-copilot:copilotcli:/history-1', {
			providerId: 'default-copilot',
			resource: URI.parse('copilotcli:/history-1'),
			workspaceUri: URI.parse('file:///workspace/msbench-logs'),
			createdAt: new Date('2026-01-01T00:00:00.000Z'),
			title: 'History marker one details',
		});
		const middleCommitted = createSession('default-copilot:copilotcli:/history-2', {
			providerId: 'default-copilot',
			resource: URI.parse('copilotcli:/history-2'),
			workspaceUri: URI.parse('file:///workspace/msbench-logs'),
			createdAt: new Date('2026-01-02T00:00:00.000Z'),
			title: 'History marker one details',
		});
		const preferredCommitted = createSession('default-copilot:copilotcli:/history-3', {
			providerId: 'default-copilot',
			resource: URI.parse('copilotcli:/history-3'),
			workspaceUri: URI.parse('file:///workspace/msbench-logs'),
			createdAt: new Date('2026-01-03T00:00:00.000Z'),
			title: 'Analysis benchmark run id 24674227624',
		});
		sessions.push(firstCommitted, middleCommitted, preferredCommitted);
		sessionsChanged.fire({ added: [firstCommitted, middleCommitted, preferredCommitted], removed: [], changed: [] });

		assert.deepStrictEqual(service.getWorkItem('work-item-1')?.sessions.get().map(session => session.sessionId), [
			middleCommitted.sessionId,
			preferredCommitted.sessionId,
		]);
		assert.deepStrictEqual(openedSessions, [preferredCommitted]);

		const storedWorkItems = JSON.parse(storageService.get('workItems.data', StorageScope.PROFILE) ?? '[]');
		assert.deepStrictEqual(storedWorkItems[0].sessionIds, [
			middleCommitted.sessionId,
			preferredCommitted.sessionId,
		]);
		assert.strictEqual(storedWorkItems[0].activeSessionId, preferredCommitted.sessionId);
	});

	test('eager legacy reconciliation keeps the latest sibling history when the preferred and oldest committed sessions share a title', () => {
		const storageService = disposables.add(new InMemoryStorageService());
		storageService.store('workItems.data', JSON.stringify([{
			id: 'work-item-1',
			title: 'Benchmark analysis',
			description: '',
			status: 'open',
			priority: 'focus',
			labels: [],
			workingDirectory: 'file:///workspace/msbench-logs',
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			sessionIds: [
				'default-copilot:copilotcli:/untitled-1',
				'default-copilot:copilotcli:/untitled-2',
			],
			activeSessionId: 'default-copilot:copilotcli:/untitled-2',
		}]), StorageScope.PROFILE, StorageTarget.USER);
		storageService.store('workItems.activeId', 'work-item-1', StorageScope.PROFILE, StorageTarget.USER);

		const instantiationService = disposables.add(new TestInstantiationService());
		const sessionsChanged = disposables.add(new Emitter<ISessionsChangeEvent>());
		const sessionReplaced = disposables.add(new Emitter<ISessionReplaceEvent>());
		const sessions: ISession[] = [];
		const openedSessions: ISession[] = [];
		const activeSession = observableValue<IActiveSession | undefined>('activeSession', undefined);

		instantiationService.stub(IStorageService, storageService);
		instantiationService.stub(IContextKeyService, new MockContextKeyService());
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override readonly onDidChangeSessions = sessionsChanged.event;
			override readonly onDidReplaceSession = sessionReplaced.event;
			override readonly activeSession = activeSession;
			override readonly activeProviderId = observableValue('activeProviderId', 'default-copilot');

			override getSessions(): ISession[] {
				return [...sessions];
			}

			override async openSession(session: ISession): Promise<void> {
				openedSessions.push(session);
				activeSession.set(session as IActiveSession, undefined);
			}

			override setActiveProvider(): void { }
		}());

		const service = disposables.add(instantiationService.createInstance(WorkItemService));
		const oldestCommitted = createSession('default-copilot:copilotcli:/history-1', {
			providerId: 'default-copilot',
			resource: URI.parse('copilotcli:/history-1'),
			workspaceUri: URI.parse('file:///workspace/msbench-logs'),
			createdAt: new Date('2026-01-01T00:00:00.000Z'),
			title: 'History marker one details',
		});
		const siblingCommitted = createSession('default-copilot:copilotcli:/history-2', {
			providerId: 'default-copilot',
			resource: URI.parse('copilotcli:/history-2'),
			workspaceUri: URI.parse('file:///workspace/msbench-logs'),
			createdAt: new Date('2026-01-02T00:00:00.000Z'),
			title: 'History marker two details',
		});
		const preferredCommitted = createSession('default-copilot:copilotcli:/history-3', {
			providerId: 'default-copilot',
			resource: URI.parse('copilotcli:/history-3'),
			workspaceUri: URI.parse('file:///workspace/msbench-logs'),
			createdAt: new Date('2026-01-03T00:00:00.000Z'),
			title: 'History marker one details',
		});
		sessions.push(oldestCommitted, siblingCommitted, preferredCommitted);
		sessionsChanged.fire({ added: [oldestCommitted, siblingCommitted, preferredCommitted], removed: [], changed: [] });

		assert.deepStrictEqual(service.getWorkItem('work-item-1')?.sessions.get().map(session => session.sessionId), [
			siblingCommitted.sessionId,
			preferredCommitted.sessionId,
		]);
		assert.deepStrictEqual(openedSessions, [preferredCommitted]);

		const storedWorkItems = JSON.parse(storageService.get('workItems.data', StorageScope.PROFILE) ?? '[]');
		assert.deepStrictEqual(storedWorkItems[0].sessionIds, [
			siblingCommitted.sessionId,
			preferredCommitted.sessionId,
		]);
		assert.strictEqual(storedWorkItems[0].activeSessionId, preferredCommitted.sessionId);
	});

	test('keeps the most recent sibling histories browsable when restoring a preferred persisted history', () => {
		const storageService = disposables.add(new InMemoryStorageService());
		storageService.store('workItems.data', JSON.stringify([{
			id: 'work-item-1',
			title: 'Benchmark analysis',
			description: '',
			status: 'open',
			priority: 'focus',
			labels: [],
			workingDirectory: 'file:///workspace/msbench-logs',
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			sessionIds: [
				'default-copilot:copilotcli:/untitled-1',
				'default-copilot:copilotcli:/untitled-2',
				'default-copilot:copilotcli:/untitled-3',
			],
			activeSessionId: 'default-copilot:copilotcli:/untitled-3',
		}]), StorageScope.PROFILE, StorageTarget.USER);
		storageService.store('workItems.activeId', 'work-item-1', StorageScope.PROFILE, StorageTarget.USER);

		const instantiationService = disposables.add(new TestInstantiationService());
		const sessionsChanged = disposables.add(new Emitter<ISessionsChangeEvent>());
		const sessionReplaced = disposables.add(new Emitter<ISessionReplaceEvent>());
		const sessions: ISession[] = [];
		const openedSessions: ISession[] = [];
		const activeSession = observableValue<IActiveSession | undefined>('activeSession', undefined);

		instantiationService.stub(IStorageService, storageService);
		instantiationService.stub(IContextKeyService, new MockContextKeyService());
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override readonly onDidChangeSessions = sessionsChanged.event;
			override readonly onDidReplaceSession = sessionReplaced.event;
			override readonly activeSession = activeSession;
			override readonly activeProviderId = observableValue('activeProviderId', 'default-copilot');

			override getSessions(): ISession[] {
				return [...sessions];
			}

			override async openSession(session: ISession): Promise<void> {
				openedSessions.push(session);
				activeSession.set(session as IActiveSession, undefined);
			}

			override setActiveProvider(): void { }
		}());

		const service = disposables.add(instantiationService.createInstance(WorkItemService));
		const oldestCommitted = createSession('default-copilot:copilotcli:/history-1', {
			providerId: 'default-copilot',
			resource: URI.parse('copilotcli:/history-1'),
			workspaceUri: URI.parse('file:///workspace/msbench-logs'),
			createdAt: new Date('2026-01-01T00:00:00.000Z'),
			title: 'History marker one details',
		});
		const olderSiblingCommitted = createSession('default-copilot:copilotcli:/history-2', {
			providerId: 'default-copilot',
			resource: URI.parse('copilotcli:/history-2'),
			workspaceUri: URI.parse('file:///workspace/msbench-logs'),
			createdAt: new Date('2026-01-02T00:00:00.000Z'),
			title: 'History marker two details',
		});
		const recentSiblingCommitted = createSession('default-copilot:copilotcli:/history-3', {
			providerId: 'default-copilot',
			resource: URI.parse('copilotcli:/history-3'),
			workspaceUri: URI.parse('file:///workspace/msbench-logs'),
			createdAt: new Date('2026-01-03T00:00:00.000Z'),
			title: 'History marker three details',
		});
		const preferredCommitted = createSession('default-copilot:copilotcli:/history-4', {
			providerId: 'default-copilot',
			resource: URI.parse('copilotcli:/history-4'),
			workspaceUri: URI.parse('file:///workspace/msbench-logs'),
			createdAt: new Date('2026-01-04T00:00:00.000Z'),
			title: 'Analysis benchmark run id 24674227624',
		});
		sessions.push(oldestCommitted, olderSiblingCommitted, recentSiblingCommitted, preferredCommitted);
		sessionsChanged.fire({ added: [oldestCommitted, olderSiblingCommitted, recentSiblingCommitted, preferredCommitted], removed: [], changed: [] });

		assert.deepStrictEqual(service.getWorkItem('work-item-1')?.sessions.get().map(session => session.sessionId), [
			olderSiblingCommitted.sessionId,
			recentSiblingCommitted.sessionId,
			preferredCommitted.sessionId,
		]);
		assert.deepStrictEqual(openedSessions, [preferredCommitted]);

		const storedWorkItems = JSON.parse(storageService.get('workItems.data', StorageScope.PROFILE) ?? '[]');
		assert.deepStrictEqual(storedWorkItems[0].sessionIds, [
			olderSiblingCommitted.sessionId,
			recentSiblingCommitted.sessionId,
			preferredCommitted.sessionId,
		]);
		assert.strictEqual(storedWorkItems[0].activeSessionId, preferredCommitted.sessionId);
	});

	test('reconciles legacy histories by session binding key so mixed copilotcli and claude histories do not displace sibling tabs', () => {
		const storageService = disposables.add(new InMemoryStorageService());
		storageService.store('workItems.data', JSON.stringify([{
			id: 'work-item-1',
			title: 'Benchmark analysis',
			description: '',
			status: 'open',
			priority: 'focus',
			labels: [],
			workingDirectory: 'file:///workspace/msbench-logs',
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			sessionIds: [
				'default-copilot:copilotcli:/untitled-1',
				'default-copilot:claude-code:/untitled-1',
				'default-copilot:copilotcli:/untitled-2',
			],
			activeSessionId: 'default-copilot:copilotcli:/untitled-2',
		}]), StorageScope.PROFILE, StorageTarget.USER);
		storageService.store('workItems.activeId', 'work-item-1', StorageScope.PROFILE, StorageTarget.USER);

		const instantiationService = disposables.add(new TestInstantiationService());
		const sessionsChanged = disposables.add(new Emitter<ISessionsChangeEvent>());
		const sessionReplaced = disposables.add(new Emitter<ISessionReplaceEvent>());
		const sessions: ISession[] = [];
		const openedSessions: ISession[] = [];
		const activeSession = observableValue<IActiveSession | undefined>('activeSession', undefined);

		instantiationService.stub(IStorageService, storageService);
		instantiationService.stub(IContextKeyService, new MockContextKeyService());
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override readonly onDidChangeSessions = sessionsChanged.event;
			override readonly onDidReplaceSession = sessionReplaced.event;
			override readonly activeSession = activeSession;
			override readonly activeProviderId = observableValue('activeProviderId', 'default-copilot');

			override getSessions(): ISession[] {
				return [...sessions];
			}

			override async openSession(session: ISession): Promise<void> {
				openedSessions.push(session);
				activeSession.set(session as IActiveSession, undefined);
			}

			override setActiveProvider(): void { }
		}());

		const service = disposables.add(instantiationService.createInstance(WorkItemService));
		const olderCopilotHistory = createSession('default-copilot:copilotcli:/37e8d2ef-7075-43fd-883f-b7bbb05a370c', {
			providerId: 'default-copilot',
			resource: URI.parse('copilotcli:/37e8d2ef-7075-43fd-883f-b7bbb05a370c'),
			workspaceUri: URI.parse('file:///workspace/msbench-logs'),
			createdAt: new Date('2026-01-01T00:00:00.000Z'),
			title: 'History marker one details',
		});
		const claudeHistory = createSession('default-copilot:claude-code:/73d37688-b96f-41f0-8fc4-eceb571b2407', {
			providerId: 'default-copilot',
			resource: URI.parse('claude-code:/73d37688-b96f-41f0-8fc4-eceb571b2407'),
			workspaceUri: URI.parse('file:///workspace/msbench-logs'),
			createdAt: new Date('2026-01-02T00:00:00.000Z'),
			title: 'Analysis benchmark run id 24674227624',
		});
		const preferredCopilotHistory = createSession('default-copilot:copilotcli:/b3830605-97b9-499c-a91f-ffb31ec8d9a9', {
			providerId: 'default-copilot',
			resource: URI.parse('copilotcli:/b3830605-97b9-499c-a91f-ffb31ec8d9a9'),
			workspaceUri: URI.parse('file:///workspace/msbench-logs'),
			createdAt: new Date('2026-01-03T00:00:00.000Z'),
			title: 'History marker one details',
		});
		const missingSiblingCopilotHistory = createSession('default-copilot:copilotcli:/7eefe8dd-094d-49cc-ae91-829645593be3', {
			providerId: 'default-copilot',
			resource: URI.parse('copilotcli:/7eefe8dd-094d-49cc-ae91-829645593be3'),
			workspaceUri: URI.parse('file:///workspace/msbench-logs'),
			createdAt: new Date('2026-01-04T00:00:00.000Z'),
			title: 'History marker two details',
		});
		sessions.push(olderCopilotHistory, claudeHistory, preferredCopilotHistory, missingSiblingCopilotHistory);
		sessionsChanged.fire({ added: [olderCopilotHistory, claudeHistory, preferredCopilotHistory, missingSiblingCopilotHistory], removed: [], changed: [] });

		assert.deepStrictEqual(service.getWorkItem('work-item-1')?.sessions.get().map(session => session.sessionId), [
			preferredCopilotHistory.sessionId,
			claudeHistory.sessionId,
			missingSiblingCopilotHistory.sessionId,
		]);
		assert.deepStrictEqual(openedSessions, [missingSiblingCopilotHistory]);

		const storedWorkItems = JSON.parse(storageService.get('workItems.data', StorageScope.PROFILE) ?? '[]');
		assert.deepStrictEqual(storedWorkItems[0].sessionIds, [
			preferredCopilotHistory.sessionId,
			claudeHistory.sessionId,
			missingSiblingCopilotHistory.sessionId,
		]);
		assert.strictEqual(storedWorkItems[0].activeSessionId, missingSiblingCopilotHistory.sessionId);
	});

	test('does not attach histories that are already owned by another work item during eager legacy reconciliation', () => {
		const storageService = disposables.add(new InMemoryStorageService());
		storageService.store('workItems.data', JSON.stringify([{
			id: 'work-item-active',
			title: 'Benchmark analysis',
			description: '',
			status: 'open',
			priority: 'focus',
			labels: [],
			workingDirectory: 'file:///workspace/msbench-logs',
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			sessionIds: [
				'default-copilot:copilotcli:/untitled-1',
				'default-copilot:copilotcli:/untitled-2',
			],
			activeSessionId: 'default-copilot:copilotcli:/untitled-2',
		}, {
			id: 'work-item-other',
			title: 'Other msbench task',
			description: '',
			status: 'open',
			priority: 'focus',
			labels: [],
			workingDirectory: 'file:///workspace/msbench-logs',
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			sessionIds: ['default-copilot:copilotcli:/owned-by-other'],
		}]), StorageScope.PROFILE, StorageTarget.USER);
		storageService.store('workItems.activeId', 'work-item-active', StorageScope.PROFILE, StorageTarget.USER);

		const instantiationService = disposables.add(new TestInstantiationService());
		const sessionsChanged = disposables.add(new Emitter<ISessionsChangeEvent>());
		const sessionReplaced = disposables.add(new Emitter<ISessionReplaceEvent>());
		const sessions: ISession[] = [];
		const openedSessions: ISession[] = [];
		const activeSession = observableValue<IActiveSession | undefined>('activeSession', undefined);

		instantiationService.stub(IStorageService, storageService);
		instantiationService.stub(IContextKeyService, new MockContextKeyService());
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override readonly onDidChangeSessions = sessionsChanged.event;
			override readonly onDidReplaceSession = sessionReplaced.event;
			override readonly activeSession = activeSession;
			override readonly activeProviderId = observableValue('activeProviderId', 'default-copilot');

			override getSessions(): ISession[] {
				return [...sessions];
			}

			override async openSession(session: ISession): Promise<void> {
				openedSessions.push(session);
				activeSession.set(session as IActiveSession, undefined);
			}

			override setActiveProvider(): void { }
		}());

		const service = disposables.add(instantiationService.createInstance(WorkItemService));
		const ownedByOther = createSession('default-copilot:copilotcli:/owned-by-other', {
			providerId: 'default-copilot',
			resource: URI.parse('copilotcli:/owned-by-other'),
			workspaceUri: URI.parse('file:///workspace/msbench-logs'),
		});
		const candidateForActive = createSession('default-copilot:copilotcli:/candidate-for-active', {
			providerId: 'default-copilot',
			resource: URI.parse('copilotcli:/candidate-for-active'),
			workspaceUri: URI.parse('file:///workspace/msbench-logs'),
		});

		// The unrelated work item's committed history is older, so the current eager
		// reconciliation logic will steal it first unless it explicitly excludes
		// histories already claimed by another work item.
		sessions.push(ownedByOther, candidateForActive);
		sessionsChanged.fire({ added: [ownedByOther, candidateForActive], removed: [], changed: [] });

		assert.deepStrictEqual(service.getWorkItem('work-item-other')?.sessions.get().map(session => session.sessionId), [
			ownedByOther.sessionId,
		]);
		assert.deepStrictEqual(service.getWorkItem('work-item-active')?.sessions.get().map(session => session.sessionId), [
			candidateForActive.sessionId,
		]);
		assert.deepStrictEqual(openedSessions, [candidateForActive]);

		const storedWorkItems = JSON.parse(storageService.get('workItems.data', StorageScope.PROFILE) ?? '[]');
		assert.deepStrictEqual(storedWorkItems[0].sessionIds, [
			'default-copilot:copilotcli:/untitled-1',
			candidateForActive.sessionId,
		]);
	});

	test('does not reconcile a directly opened committed history that is already owned by another work item', () => {
		const storageService = disposables.add(new InMemoryStorageService());
		storageService.store('workItems.data', JSON.stringify([{
			id: 'work-item-active',
			title: 'Benchmark analysis',
			description: '',
			status: 'open',
			priority: 'focus',
			labels: [],
			workingDirectory: 'file:///workspace/msbench-logs',
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			sessionIds: [
				'default-copilot:copilotcli:/untitled-1',
			],
		}, {
			id: 'work-item-other',
			title: 'Other msbench task',
			description: '',
			status: 'open',
			priority: 'focus',
			labels: [],
			workingDirectory: 'file:///workspace/msbench-logs',
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			sessionIds: ['default-copilot:copilotcli:/owned-by-other'],
		}]), StorageScope.PROFILE, StorageTarget.USER);
		storageService.store('workItems.activeId', 'work-item-active', StorageScope.PROFILE, StorageTarget.USER);

		const instantiationService = disposables.add(new TestInstantiationService());
		const sessionsChanged = disposables.add(new Emitter<ISessionsChangeEvent>());
		const sessionReplaced = disposables.add(new Emitter<ISessionReplaceEvent>());
		const sessions: ISession[] = [];
		const activeSession = observableValue<IActiveSession | undefined>('activeSession', undefined);

		instantiationService.stub(IStorageService, storageService);
		instantiationService.stub(IContextKeyService, new MockContextKeyService());
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override readonly onDidChangeSessions = sessionsChanged.event;
			override readonly onDidReplaceSession = sessionReplaced.event;
			override readonly activeSession = activeSession;
			override readonly activeProviderId = observableValue('activeProviderId', 'default-copilot');

			override getSessions(): ISession[] {
				return [...sessions];
			}

			override async openSession(): Promise<void> { }
			override setActiveProvider(): void { }
		}());

		const service = disposables.add(instantiationService.createInstance(WorkItemService));
		const ownedByOther = createSession('default-copilot:copilotcli:/owned-by-other', {
			providerId: 'default-copilot',
			resource: URI.parse('copilotcli:/owned-by-other'),
			workspaceUri: URI.parse('file:///workspace/msbench-logs'),
		});
		sessions.push(ownedByOther);
		sessionsChanged.fire({ added: [ownedByOther], removed: [], changed: [] });
		activeSession.set(ownedByOther, undefined);

		assert.deepStrictEqual(service.getWorkItem('work-item-active')?.sessions.get(), []);
		assert.deepStrictEqual(service.getWorkItem('work-item-other')?.sessions.get().map(session => session.sessionId), [
			ownedByOther.sessionId,
		]);

		const storedWorkItems = JSON.parse(storageService.get('workItems.data', StorageScope.PROFILE) ?? '[]');
		assert.deepStrictEqual(storedWorkItems[0].sessionIds, ['default-copilot:copilotcli:/untitled-1']);
		assert.strictEqual(storedWorkItems[0].activeSessionId, undefined);
	});

	test('does not reconcile a committed history session into a different work-item workspace', () => {
		const storageService = disposables.add(new InMemoryStorageService());
		storageService.store('workItems.data', JSON.stringify([{
			id: 'work-item-1',
			title: 'Benchmark analysis',
			description: '',
			status: 'open',
			priority: 'focus',
			labels: [],
			workingDirectory: 'file:///workspace/msbench-logs',
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			sessionIds: [
				'default-copilot:copilotcli:/untitled-1',
			],
		}]), StorageScope.PROFILE, StorageTarget.USER);
		storageService.store('workItems.activeId', 'work-item-1', StorageScope.PROFILE, StorageTarget.USER);

		const instantiationService = disposables.add(new TestInstantiationService());
		const sessionsChanged = disposables.add(new Emitter<ISessionsChangeEvent>());
		const sessionReplaced = disposables.add(new Emitter<ISessionReplaceEvent>());
		const sessions: ISession[] = [];
		const activeSession = observableValue<IActiveSession | undefined>('activeSession', undefined);

		instantiationService.stub(IStorageService, storageService);
		instantiationService.stub(IContextKeyService, new MockContextKeyService());
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override readonly onDidChangeSessions = sessionsChanged.event;
			override readonly onDidReplaceSession = sessionReplaced.event;
			override readonly activeSession = activeSession;
			override readonly activeProviderId = observableValue('activeProviderId', 'default-copilot');

			override getSessions(): ISession[] {
				return [...sessions];
			}

			override async openSession(): Promise<void> { }
			override setActiveProvider(): void { }
		}());

		const service = disposables.add(instantiationService.createInstance(WorkItemService));
		const committedSession = createSession('default-copilot:copilotcli:/37e8d2ef-7075-43fd-883f-b7bbb05a370c', {
			providerId: 'default-copilot',
			resource: URI.parse('copilotcli:/37e8d2ef-7075-43fd-883f-b7bbb05a370c'),
			workspaceUri: URI.parse('file:///workspace/appmod-rearchitecture'),
		});
		sessions.push(committedSession);
		activeSession.set(committedSession, undefined);

		assert.deepStrictEqual(service.getWorkItem('work-item-1')?.sessions.get(), []);

		const storedWorkItems = JSON.parse(storageService.get('workItems.data', StorageScope.PROFILE) ?? '[]');
		assert.deepStrictEqual(storedWorkItems[0].sessionIds, ['default-copilot:copilotcli:/untitled-1']);
		assert.strictEqual(storedWorkItems[0].activeSessionId, undefined);
	});
});
