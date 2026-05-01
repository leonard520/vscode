/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun, IObservable, ISettableObservable, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { bindContextKey } from '../../../../platform/observable/common/platformObservableUtils.js';
import { ActiveWorkItemHasLinkedIssueContext, ActiveWorkItemHasWorkingDirectoryContext, ActiveWorkItemPriorityContext, ActiveWorkItemSessionCountContext, ActiveWorkItemStatusContext, HasActiveWorkItemContext, IsNewChatSessionContext } from '../../../common/contextkeys.js';
import { ISession } from '../../sessions/common/session.js';
import { ISessionsManagementService } from '../../sessions/common/sessionsManagement.js';
import { ILinkedGitHubIssue, IWorkItem, IWorkItemData, IWorkItemDiscussion, WorkItemPriority, WorkItemStatus } from '../common/workItem.js';
import { IWorkItemChangeEvent, IWorkItemCreateData, IWorkItemService, IWorkItemUpdateData } from '../common/workItemService.js';

const WORK_ITEMS_STORAGE_KEY = 'workItems.data';
const ACTIVE_WORK_ITEM_KEY = 'workItems.activeId';
const LOG_PREFIX = '[WorkItemService]';

class WorkItemModel implements IWorkItem {
	readonly id: string;
	readonly createdAt: Date;

	readonly title: ISettableObservable<string>;
	readonly description: ISettableObservable<string>;
	readonly status: ISettableObservable<WorkItemStatus>;
	readonly priority: ISettableObservable<WorkItemPriority>;
	readonly labels: ISettableObservable<readonly string[]>;
	readonly linkedIssue: ISettableObservable<ILinkedGitHubIssue | undefined>;
	readonly workingDirectory: ISettableObservable<URI | undefined>;
	readonly updatedAt: ISettableObservable<Date>;
	readonly sessions: ISettableObservable<readonly ISession[]>;
	readonly discussions: ISettableObservable<readonly IWorkItemDiscussion[]>;

	private _sessionIds: string[];
	private _activeSessionId: string | undefined;

	constructor(data: IWorkItemData) {
		this.id = data.id;
		this.createdAt = new Date(data.createdAt);
		this._sessionIds = [...data.sessionIds];
		this._activeSessionId = data.activeSessionId;

		this.title = observableValue(`workItem.title.${this.id}`, data.title);
		this.description = observableValue(`workItem.description.${this.id}`, data.description);
		this.status = observableValue(`workItem.status.${this.id}`, data.status);
		this.priority = observableValue(`workItem.priority.${this.id}`, data.priority);
		this.labels = observableValue(`workItem.labels.${this.id}`, data.labels);
		this.linkedIssue = observableValue(`workItem.linkedIssue.${this.id}`, data.linkedIssue);
		this.workingDirectory = observableValue(`workItem.workingDirectory.${this.id}`, data.workingDirectory ? URI.parse(data.workingDirectory) : undefined);
		this.updatedAt = observableValue(`workItem.updatedAt.${this.id}`, new Date(data.updatedAt));
		this.sessions = observableValue(`workItem.sessions.${this.id}`, []);
		this.discussions = observableValue(`workItem.discussions.${this.id}`, data.discussions ? [...data.discussions] : []);
	}

	get sessionIds(): readonly string[] {
		return this._sessionIds;
	}

	get activeSessionId(): string | undefined {
		return this._activeSessionId;
	}

	replaceSessionId(fromSessionId: string, toSessionId: string): boolean {
		if (fromSessionId === toSessionId) {
			return false;
		}

		const fromIndex = this._sessionIds.indexOf(fromSessionId);
		if (fromIndex < 0) {
			return false;
		}

		const existingTargetIndex = this._sessionIds.indexOf(toSessionId);
		if (existingTargetIndex >= 0) {
			this._sessionIds.splice(fromIndex, 1);
		} else {
			this._sessionIds.splice(fromIndex, 1, toSessionId);
		}

		if (this._activeSessionId === fromSessionId) {
			this._activeSessionId = toSessionId;
		}

		return true;
	}

	addSessionId(sessionId: string): void {
		if (!this._sessionIds.includes(sessionId)) {
			this._sessionIds.push(sessionId);
		}
	}

	removeSessionId(sessionId: string): void {
		const idx = this._sessionIds.indexOf(sessionId);
		if (idx >= 0) {
			this._sessionIds.splice(idx, 1);
		}

		if (this._activeSessionId === sessionId) {
			this._activeSessionId = undefined;
		}
	}

	setActiveSessionId(sessionId: string | undefined): boolean {
		if (this._activeSessionId === sessionId) {
			return false;
		}

		this._activeSessionId = sessionId;
		return true;
	}

	toData(): IWorkItemData {
		return {
			id: this.id,
			title: this.title.get(),
			description: this.description.get(),
			status: this.status.get(),
			priority: this.priority.get(),
			labels: [...this.labels.get()],
			linkedIssue: this.linkedIssue.get(),
			workingDirectory: this.workingDirectory.get()?.toString(),
			createdAt: this.createdAt.toISOString(),
			updatedAt: this.updatedAt.get().toISOString(),
			sessionIds: [...this._sessionIds],
			activeSessionId: this._activeSessionId,
			discussions: [...this.discussions.get()],
		};
	}
}

export class WorkItemService extends Disposable implements IWorkItemService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeWorkItems = this._register(new Emitter<IWorkItemChangeEvent>());
	readonly onDidChangeWorkItems: Event<IWorkItemChangeEvent> = this._onDidChangeWorkItems.event;

	private readonly _activeWorkItem: ISettableObservable<IWorkItem | undefined>;
	get activeWorkItem(): IObservable<IWorkItem | undefined> { return this._activeWorkItem; }

	private readonly _workItems = new Map<string, WorkItemModel>();
	private readonly _pendingSessions = new Map<string, ISession>();

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@ILogService private readonly _logService: ILogService,
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
	) {
		super();

		this._activeWorkItem = observableValue('workItemService.activeWorkItem', undefined);

		this._register(bindContextKey(HasActiveWorkItemContext, this._contextKeyService, reader => {
			return !!this._activeWorkItem.read(reader);
		}));
		this._register(bindContextKey(ActiveWorkItemHasLinkedIssueContext, this._contextKeyService, reader => {
			return !!this._activeWorkItem.read(reader)?.linkedIssue.read(reader);
		}));
		this._register(bindContextKey(ActiveWorkItemHasWorkingDirectoryContext, this._contextKeyService, reader => {
			return !!this._activeWorkItem.read(reader)?.workingDirectory.read(reader);
		}));
		this._register(bindContextKey(ActiveWorkItemStatusContext, this._contextKeyService, reader => {
			return this._activeWorkItem.read(reader)?.status.read(reader) ?? WorkItemStatus.Open;
		}));
		this._register(bindContextKey(ActiveWorkItemPriorityContext, this._contextKeyService, reader => {
			return this._activeWorkItem.read(reader)?.priority.read(reader) ?? WorkItemPriority.Backlog;
		}));
		this._register(bindContextKey(ActiveWorkItemSessionCountContext, this._contextKeyService, reader => {
			return this._activeWorkItem.read(reader)?.sessions.read(reader).length ?? 0;
		}));

		this._loadFromStorage();
		this._resolveSessionReferences();

		// Keep session references fresh when sessions change
		this._register(this._sessionsManagementService.onDidChangeSessions(() => {
			this._resolveSessionReferences();
			this._syncActiveWorkItemSession();
		}));
		this._register(this._sessionsManagementService.onDidReplaceSession(e => {
			this._replaceSessionReference(e.from.sessionId, e.to);
			this._syncActiveWorkItemSession();
		}));

		this._register(autorun(reader => {
			const activeWorkItem = this._activeWorkItem.read(reader);
			if (!activeWorkItem) {
				return;
			}

			const activeSession = this._sessionsManagementService.activeSession.read(reader);
			const sessions = this._rehydrateActiveSessionForWorkItem(activeWorkItem.id, activeWorkItem.sessions.read(reader), activeSession);
			this._rememberActiveSession(activeWorkItem.id, sessions, activeSession);
			if (sessions.length === 0) {
				return;
			}

			if (activeSession && sessions.some(session => session.sessionId === activeSession.sessionId)) {
				return;
			}

			if (this._contextKeyService.getContextKeyValue(IsNewChatSessionContext.key)) {
				return;
			}

			this._syncActiveWorkItemSession();
		}));

		// Persist on shutdown
		this._register(this._storageService.onWillSaveState(() => {
			this._saveToStorage();
		}));
	}

	// #region CRUD

	getWorkItems(): readonly IWorkItem[] {
		return [...this._workItems.values()];
	}

	getWorkItem(id: string): IWorkItem | undefined {
		return this._workItems.get(id);
	}

	createWorkItem(data: IWorkItemCreateData): IWorkItem {
		const now = new Date().toISOString();
		const itemData: IWorkItemData = {
			id: generateUuid(),
			title: data.title,
			description: data.description ?? '',
			status: WorkItemStatus.Open,
			priority: data.priority ?? WorkItemPriority.Focus,
			labels: data.labels ?? [],
			linkedIssue: data.linkedIssue,
			workingDirectory: data.workingDirectory?.toString(),
			createdAt: now,
			updatedAt: now,
			sessionIds: [],
		};

		const model = new WorkItemModel(itemData);
		this._workItems.set(model.id, model);
		this._saveToStorage();

		this._logService.debug(LOG_PREFIX, `Created work item "${model.title.get()}" (${model.id})`);
		this._onDidChangeWorkItems.fire({ added: [model], removed: [], changed: [] });

		return model;
	}

	updateWorkItem(id: string, changes: IWorkItemUpdateData): void {
		const model = this._workItems.get(id);
		if (!model) {
			this._logService.warn(LOG_PREFIX, `Cannot update unknown work item: ${id}`);
			return;
		}

		if (changes.title !== undefined) {
			model.title.set(changes.title, undefined);
		}
		if (changes.description !== undefined) {
			model.description.set(changes.description, undefined);
		}
		if (changes.status !== undefined) {
			model.status.set(changes.status, undefined);
		}
		if (changes.priority !== undefined) {
			model.priority.set(changes.priority, undefined);
		}
		if (changes.labels !== undefined) {
			model.labels.set(changes.labels, undefined);
		}
		if (changes.linkedIssue !== undefined) {
			model.linkedIssue.set(changes.linkedIssue, undefined);
		}
		if (changes.workingDirectory !== undefined) {
			model.workingDirectory.set(changes.workingDirectory, undefined);
		}

		model.updatedAt.set(new Date(), undefined);
		this._saveToStorage();

		this._onDidChangeWorkItems.fire({ added: [], removed: [], changed: [model] });
	}

	deleteWorkItem(id: string): void {
		const model = this._workItems.get(id);
		if (!model) {
			return;
		}

		for (const sessionId of model.sessionIds) {
			this._pendingSessions.delete(sessionId);
		}

		this._workItems.delete(id);
		this._saveToStorage();

		if (this._activeWorkItem.get()?.id === id) {
			this._activeWorkItem.set(undefined, undefined);
			this._storageService.remove(ACTIVE_WORK_ITEM_KEY, StorageScope.PROFILE);
		}

		this._logService.debug(LOG_PREFIX, `Deleted work item "${model.title.get()}" (${id})`);
		this._onDidChangeWorkItems.fire({ added: [], removed: [model], changed: [] });
	}

	setActiveWorkItem(id: string | undefined): void {
		if (id === undefined) {
			this._activeWorkItem.set(undefined, undefined);
			this._storageService.remove(ACTIVE_WORK_ITEM_KEY, StorageScope.PROFILE);
			return;
		}

		const model = this._workItems.get(id);
		if (!model) {
			this._logService.warn(LOG_PREFIX, `Cannot activate unknown work item: ${id}`);
			return;
		}

		this._activeWorkItem.set(model, undefined);
		this._storageService.store(ACTIVE_WORK_ITEM_KEY, id, StorageScope.PROFILE, StorageTarget.USER);
		this._syncActiveWorkItemSession();
	}

	// #endregion

	// #region Session association

	addSession(workItemId: string, sessionId: string): void {
		const model = this._workItems.get(workItemId);
		if (!model) {
			return;
		}

		model.addSessionId(sessionId);
		this._resolveSessionReferencesForItem(model);
		model.updatedAt.set(new Date(), undefined);
		this._saveToStorage();
		this._onDidChangeWorkItems.fire({ added: [], removed: [], changed: [model] });
	}

	removeSession(workItemId: string, sessionId: string): void {
		const model = this._workItems.get(workItemId);
		if (!model) {
			return;
		}

		model.removeSessionId(sessionId);
		this._pendingSessions.delete(sessionId);
		this._resolveSessionReferencesForItem(model);
		model.updatedAt.set(new Date(), undefined);
		this._saveToStorage();
		this._onDidChangeWorkItems.fire({ added: [], removed: [], changed: [model] });
	}

	setPreferredSessionForWorkItem(workItemId: string, sessionId: string | undefined): void {
		const model = this._workItems.get(workItemId);
		if (!model || !model.setActiveSessionId(sessionId)) {
			return;
		}

		model.updatedAt.set(new Date(), undefined);
		this._saveToStorage();
		this._onDidChangeWorkItems.fire({ added: [], removed: [], changed: [model] });
	}

	async createSessionForWorkItem(workItemId: string): Promise<ISession> {
		const model = this._workItems.get(workItemId);
		if (!model) {
			throw new Error(`Work item not found: ${workItemId}`);
		}

		if (this._activeWorkItem.get()?.id !== workItemId) {
			this.setActiveWorkItem(workItemId);
		}

		const providerId = this._sessionsManagementService.activeProviderId.get();
		if (!providerId) {
			throw new Error('No active sessions provider');
		}

		const workingDir = model.workingDirectory.get();
		const workspaceUri = workingDir ?? URI.from({ scheme: 'untitled', path: '/' });

		const session = this._sessionsManagementService.createNewSession(providerId, workspaceUri);
		this._pendingSessions.set(session.sessionId, session);
		this.addSession(workItemId, session.sessionId);

		return session;
	}

	// #endregion

	// #region Discussions

	addDiscussion(workItemId: string, body: string): IWorkItemDiscussion {
		const model = this._workItems.get(workItemId);
		if (!model) {
			throw new Error(`Work item not found: ${workItemId}`);
		}

		const discussion: IWorkItemDiscussion = {
			id: generateUuid(),
			createdAt: new Date().toISOString(),
			body,
			syncedToGitHub: false,
		};

		model.discussions.set([...model.discussions.get(), discussion], undefined);
		model.updatedAt.set(new Date(), undefined);
		this._saveToStorage();

		this._onDidChangeWorkItems.fire({ added: [], removed: [], changed: [model] });
		this._logService.debug(LOG_PREFIX, `Added discussion to work item "${model.title.get()}" (${workItemId})`);

		return discussion;
	}

	updateDiscussion(workItemId: string, discussionId: string, changes: Partial<Pick<IWorkItemDiscussion, 'body' | 'syncedToGitHub'>>): void {
		const model = this._workItems.get(workItemId);
		if (!model) {
			this._logService.warn(LOG_PREFIX, `Cannot update discussion on unknown work item: ${workItemId}`);
			return;
		}

		const discussions = [...model.discussions.get()];
		const idx = discussions.findIndex(d => d.id === discussionId);
		if (idx < 0) {
			this._logService.warn(LOG_PREFIX, `Discussion not found: ${discussionId}`);
			return;
		}

		discussions[idx] = { ...discussions[idx], ...changes };
		model.discussions.set(discussions, undefined);
		model.updatedAt.set(new Date(), undefined);
		this._saveToStorage();

		this._onDidChangeWorkItems.fire({ added: [], removed: [], changed: [model] });
	}

	// #endregion

	// #region Persistence

	private _loadFromStorage(): void {
		const raw = this._storageService.get(WORK_ITEMS_STORAGE_KEY, StorageScope.PROFILE);
		if (!raw) {
			return;
		}

		try {
			const items: IWorkItemData[] = JSON.parse(raw);
			for (const data of items) {
				const model = new WorkItemModel(data);
				this._workItems.set(model.id, model);
			}
		} catch (e) {
			this._logService.error(LOG_PREFIX, 'Failed to load work items from storage', e);
		}

		// Restore active work item
		const activeId = this._storageService.get(ACTIVE_WORK_ITEM_KEY, StorageScope.PROFILE);
		if (activeId) {
			const model = this._workItems.get(activeId);
			if (model) {
				this._activeWorkItem.set(model, undefined);
			}
		}
	}

	private _saveToStorage(): void {
		const items: IWorkItemData[] = [];
		for (const model of this._workItems.values()) {
			items.push(model.toData());
		}
		this._storageService.store(WORK_ITEMS_STORAGE_KEY, JSON.stringify(items), StorageScope.PROFILE, StorageTarget.USER);
	}

	// #endregion

	// #region Session resolution

	private _resolveSessionReferences(): void {
		for (const model of this._workItems.values()) {
			this._resolveSessionReferencesForItem(model);
		}
	}

	private _resolveSessionReferencesForItem(model: WorkItemModel): void {
		const allSessions = this._sessionsManagementService.getSessions();
		this._reconcilePersistedLegacySessionsForItem(model, allSessions);
		const resolved: ISession[] = [];

		for (const sessionId of model.sessionIds) {
			const session = allSessions.find(s => s.sessionId === sessionId);
			if (session) {
				this._pendingSessions.delete(sessionId);
				resolved.push(session);
				continue;
			}

			const pendingSession = this._pendingSessions.get(sessionId);
			if (pendingSession) {
				resolved.push(pendingSession);
			}
		}

		model.sessions.set(resolved, undefined);
	}

	private _reconcilePersistedLegacySessionsForItem(model: WorkItemModel, allSessions: readonly ISession[]): void {
		const unresolvedLegacySessionIds = model.sessionIds.filter(sessionId => {
			return !allSessions.some(session => session.sessionId === sessionId)
				&& !this._pendingSessions.has(sessionId)
				&& this._getLegacyPendingSessionBindingKey(sessionId) !== undefined;
		});

		if (unresolvedLegacySessionIds.length === 0) {
			return;
		}

		const candidateSessions = this._getPersistedLegacySessionCandidates(model, allSessions);
		if (candidateSessions.length === 0) {
			return;
		}

		let didChange = false;
		for (const [legacySessionId, candidateSession] of this._matchPersistedLegacySessions(model, unresolvedLegacySessionIds, candidateSessions)) {

			this._pendingSessions.delete(legacySessionId);
			this._pendingSessions.set(candidateSession.sessionId, candidateSession);
			didChange = model.replaceSessionId(legacySessionId, candidateSession.sessionId) || didChange;
		}

		if (!didChange) {
			return;
		}

		model.updatedAt.set(new Date(), undefined);
		this._saveToStorage();
		this._logService.info(LOG_PREFIX, `Eagerly reconciled persisted work item histories for ${model.id}`);
	}

	private _matchPersistedLegacySessions(model: WorkItemModel, legacySessionIds: readonly string[], candidateSessions: readonly ISession[]): Map<string, ISession> {
		const assignments = new Map<string, ISession>();
		const legacySessionIdsByBindingKey = new Map<string, string[]>();
		const candidateSessionsByBindingKey = new Map<string, ISession[]>();

		for (const legacySessionId of legacySessionIds) {
			const bindingKey = this._getLegacyPendingSessionBindingKey(legacySessionId);
			if (!bindingKey) {
				continue;
			}

			let bindingKeyLegacySessionIds = legacySessionIdsByBindingKey.get(bindingKey);
			if (!bindingKeyLegacySessionIds) {
				bindingKeyLegacySessionIds = [];
				legacySessionIdsByBindingKey.set(bindingKey, bindingKeyLegacySessionIds);
			}

			bindingKeyLegacySessionIds.push(legacySessionId);
		}

		for (const candidateSession of candidateSessions) {
			const bindingKey = this._getSessionBindingKey(candidateSession);
			if (!bindingKey) {
				continue;
			}

			let bindingKeyCandidateSessions = candidateSessionsByBindingKey.get(bindingKey);
			if (!bindingKeyCandidateSessions) {
				bindingKeyCandidateSessions = [];
				candidateSessionsByBindingKey.set(bindingKey, bindingKeyCandidateSessions);
			}

			bindingKeyCandidateSessions.push(candidateSession);
		}

		for (const [bindingKey, bindingKeyLegacySessionIds] of legacySessionIdsByBindingKey) {
			const bindingKeyCandidateSessions = candidateSessionsByBindingKey.get(bindingKey);
			if (!bindingKeyCandidateSessions || bindingKeyCandidateSessions.length === 0) {
				continue;
			}

			const candidateWindow = bindingKeyCandidateSessions.slice(-Math.min(bindingKeyLegacySessionIds.length, bindingKeyCandidateSessions.length));
			const preferredLegacySessionId = model.activeSessionId && bindingKeyLegacySessionIds.includes(model.activeSessionId)
				? model.activeSessionId
				: undefined;
			const remainingCandidateWindow = [...candidateWindow];

			if (preferredLegacySessionId) {
				const preferredCandidateSession = remainingCandidateWindow.pop();
				if (preferredCandidateSession) {
					assignments.set(preferredLegacySessionId, preferredCandidateSession);
				}
			}

			for (const legacySessionId of bindingKeyLegacySessionIds) {
				if (legacySessionId === preferredLegacySessionId) {
					continue;
				}

				const candidateSession = remainingCandidateWindow.shift();
				if (!candidateSession) {
					break;
				}

				assignments.set(legacySessionId, candidateSession);
			}
		}

		return assignments;
	}

	private _getPersistedLegacySessionCandidates(model: WorkItemModel, allSessions: readonly ISession[]): ISession[] {
		const workingDirectory = model.workingDirectory.get();
		if (!workingDirectory) {
			return [];
		}

		const storedSessionIds = new Set(model.sessionIds);
		const legacyBindingKeys = new Set(model.sessionIds.map(sessionId => this._getLegacyPendingSessionBindingKey(sessionId)).filter((bindingKey): bindingKey is string => !!bindingKey));
		return allSessions
			.filter(session => !storedSessionIds.has(session.sessionId))
			.filter(session => !this._isSessionOwnedByAnotherWorkItem(model.id, session.sessionId))
			.filter(session => {
				const sessionWorkspace = this._getSessionWorkspaceUri(session);
				if (!sessionWorkspace || sessionWorkspace.toString() !== workingDirectory.toString()) {
					return false;
				}

				const bindingKey = this._getSessionBindingKey(session);
				return !!bindingKey && legacyBindingKeys.has(bindingKey);
			})
			.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
	}

	private _rehydrateActiveSessionForWorkItem(workItemId: string, sessions: readonly ISession[], activeSession: ISession | undefined): readonly ISession[] {
		if (!activeSession || sessions.some(session => session.sessionId === activeSession.sessionId)) {
			return sessions;
		}

		const model = this._workItems.get(workItemId);
		if (!model) {
			return sessions;
		}

		if (!model.sessionIds.includes(activeSession.sessionId)) {
			if (!this._tryReconcileLegacySessionReference(model, activeSession)) {
				return sessions;
			}

			return model.sessions.get();
		}

		this._pendingSessions.set(activeSession.sessionId, activeSession);
		this._resolveSessionReferencesForItem(model);
		return model.sessions.get();
	}

	private _syncActiveWorkItemSession(): void {
		const activeWorkItem = this._activeWorkItem.get();
		if (!activeWorkItem) {
			return;
		}

		const sessions = activeWorkItem.sessions.get();
		if (sessions.length === 0) {
			const model = this._workItems.get(activeWorkItem.id);
			if (!model || model.sessionIds.length === 0) {
				// Only show new session view if the work item truly has no sessions
				// (not just unresolved legacy sessions waiting to be matched).
				this._sessionsManagementService.openNewSessionView();
			}
			return;
		}

		const activeSession = this._sessionsManagementService.activeSession.get();
		if (activeSession && sessions.some(session => session.sessionId === activeSession.sessionId)) {
			return;
		}

		const preferredSession = this._getPreferredSession(activeWorkItem.id, sessions);
		this._sessionsManagementService.openSession(preferredSession);
	}

	private _replaceSessionReference(fromSessionId: string, toSession: ISession): void {
		const changed: WorkItemModel[] = [];

		for (const model of this._workItems.values()) {
			if (!model.sessionIds.includes(fromSessionId)) {
				continue;
			}

			this._pendingSessions.delete(fromSessionId);
			this._pendingSessions.set(toSession.sessionId, toSession);
			if (!model.replaceSessionId(fromSessionId, toSession.sessionId)) {
				continue;
			}
			this._resolveSessionReferencesForItem(model);
			model.updatedAt.set(new Date(), undefined);
			changed.push(model);
		}

		if (!changed.length) {
			return;
		}

		this._saveToStorage();
		this._onDidChangeWorkItems.fire({ added: [], removed: [], changed });
	}

	private _rememberActiveSession(workItemId: string, sessions: readonly ISession[], activeSession: ISession | undefined): void {
		if (!activeSession || !sessions.some(session => session.sessionId === activeSession.sessionId)) {
			return;
		}

		const model = this._workItems.get(workItemId);
		if (!model || !model.setActiveSessionId(activeSession.sessionId)) {
			return;
		}

		model.updatedAt.set(new Date(), undefined);
		this._saveToStorage();
	}

	private _getPreferredSession(workItemId: string, sessions: readonly ISession[]): ISession {
		const preferredSessionId = this._workItems.get(workItemId)?.activeSessionId;
		const preferredSession = preferredSessionId ? sessions.find(session => session.sessionId === preferredSessionId) : undefined;
		return preferredSession ?? sessions[sessions.length - 1];
	}

	private _tryReconcileLegacySessionReference(model: WorkItemModel, activeSession: ISession): boolean {
		const legacySessionId = this._getLegacySessionIdForReconciliation(model, activeSession);
		if (this._isSessionOwnedByAnotherWorkItem(model.id, activeSession.sessionId)) {
			return false;
		}

		if (!legacySessionId || !model.replaceSessionId(legacySessionId, activeSession.sessionId)) {
			return false;
		}

		this._pendingSessions.delete(legacySessionId);
		this._pendingSessions.set(activeSession.sessionId, activeSession);
		this._resolveSessionReferencesForItem(model);
		model.updatedAt.set(new Date(), undefined);
		this._saveToStorage();
		this._onDidChangeWorkItems.fire({ added: [], removed: [], changed: [model] });
		this._logService.info(LOG_PREFIX, `Reconciled legacy work item session reference ${legacySessionId} -> ${activeSession.sessionId}`);
		return true;
	}

	private _getLegacySessionIdForReconciliation(model: WorkItemModel, activeSession: ISession): string | undefined {
		const bindingKey = this._getSessionBindingKey(activeSession);
		if (!bindingKey) {
			return undefined;
		}

		const preferredSessionId = model.activeSessionId;
		if (preferredSessionId && this._isLegacyPendingSessionId(preferredSessionId, bindingKey)) {
			return preferredSessionId;
		}

		const workingDirectory = model.workingDirectory.get();
		const sessionWorkspace = this._getSessionWorkspaceUri(activeSession);
		if (!workingDirectory || !sessionWorkspace || workingDirectory.toString() !== sessionWorkspace.toString()) {
			return undefined;
		}

		return model.sessionIds.find(sessionId => this._isLegacyPendingSessionId(sessionId, bindingKey));
	}

	private _isSessionOwnedByAnotherWorkItem(workItemId: string, sessionId: string): boolean {
		for (const [otherWorkItemId, model] of this._workItems) {
			if (otherWorkItemId === workItemId) {
				continue;
			}

			if (model.sessionIds.includes(sessionId)) {
				return true;
			}
		}

		return false;
	}

	private _getSessionWorkspaceUri(session: ISession): URI | undefined {
		const repository = session.workspace.get()?.repositories[0];
		return repository?.workingDirectory ?? repository?.uri;
	}

	private _getLegacyPendingSessionBindingKey(sessionId: string): string | undefined {
		const untitledMarker = ':/untitled-';
		const untitledIndex = sessionId.indexOf(untitledMarker);
		if (untitledIndex <= 0) {
			return undefined;
		}

		return sessionId.slice(0, untitledIndex);
	}

	private _getSessionBindingKey(session: ISession): string | undefined {
		const sessionIdPrefixEnd = session.sessionId.indexOf(':/');
		if (sessionIdPrefixEnd > 0) {
			return session.sessionId.slice(0, sessionIdPrefixEnd);
		}

		const scheme = session.resource.scheme;
		return scheme ? `${session.providerId}:${scheme}` : undefined;
	}

	private _isLegacyPendingSessionId(sessionId: string, bindingKey: string): boolean {
		return this._getLegacyPendingSessionBindingKey(sessionId) === bindingKey;
	}

	// #endregion
}

registerSingleton(IWorkItemService, WorkItemService, InstantiationType.Delayed);
