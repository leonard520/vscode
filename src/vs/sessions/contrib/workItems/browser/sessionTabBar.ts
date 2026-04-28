/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/sessionTabBar.css';
import * as DOM from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ISession, SessionStatus } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { IWorkItemService } from '../../../services/workItems/common/workItemService.js';

const $ = DOM.$;

/**
 * A horizontal tab bar that shows all sessions belonging to the active work item.
 * Shown above the chat widget in the Chat Bar.
 *
 * Visibility rules:
 * - Hidden when no work item is active
 * - Hidden when the active work item has 0 or 1 sessions (counting only non-archived)
 * - Visible when the active work item has 2+ non-archived sessions, or when
 *   "Show Archived" is toggled on and there are archived sessions
 */
export class SessionTabBar extends Disposable {

	private readonly _onDidChangeVisibility = this._register(new Emitter<boolean>());
	readonly onDidChangeVisibility: Event<boolean> = this._onDidChangeVisibility.event;

	private readonly _element: HTMLElement;
	private readonly _tabsContainer: HTMLElement;
	private readonly _addButton: HTMLElement;
	private readonly _showArchivedButton: HTMLElement;
	private readonly _sessionsDisposables = this._register(new DisposableStore());
	private _visible = true;
	private _showArchived = false;

	get element(): HTMLElement {
		return this._element;
	}

	get visible(): boolean {
		return this._visible;
	}

	constructor(
		parent: HTMLElement,
		@IWorkItemService private readonly _workItemService: IWorkItemService,
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
	) {
		super();

		this._element = DOM.append(parent, $('.session-tab-bar'));
		this._tabsContainer = DOM.append(this._element, $('div'));
		this._tabsContainer.style.display = 'contents';

		this._addButton = DOM.append(this._element, $('div.session-tab-add'));
		this._addButton.title = localize('sessionTabBar.newSession', "New Session");
		this._addButton.setAttribute('role', 'button');
		this._addButton.setAttribute('aria-label', localize('sessionTabBar.newSession', "New Session"));
		const addIcon = DOM.append(this._addButton, $(ThemeIcon.asCSSSelector(Codicon.add)));
		addIcon.style.pointerEvents = 'none';

		// Show Archived toggle button
		this._showArchivedButton = DOM.append(this._element, $('div.session-tab-show-archived'));
		this._showArchivedButton.setAttribute('role', 'button');
		this._updateShowArchivedButton();

		this._register(DOM.addDisposableListener(this._addButton, DOM.EventType.CLICK, () => this._onAddSession()));
		this._register(DOM.addDisposableListener(this._showArchivedButton, DOM.EventType.CLICK, () => this._toggleShowArchived()));

		// React to active work item changes
		this._register(autorun(reader => {
			const workItem = this._workItemService.activeWorkItem.read(reader);
			if (!workItem) {
				this._setVisible(false);
				return;
			}

			const sessions = workItem.sessions.read(reader);
			// Read isArchived for each session so the autorun re-fires on archive state changes
			const activeSessions: ISession[] = [];
			const archivedSessions: ISession[] = [];
			for (const session of sessions) {
				if (session.isArchived.read(reader)) {
					archivedSessions.push(session);
				} else {
					activeSessions.push(session);
				}
			}

			const activeSession = this._sessionsManagementService.activeSession.read(reader);
			const visibleSessions = this._showArchived ? sessions : activeSessions;

			// Show the toggle button only when there are archived sessions
			this._showArchivedButton.style.display = archivedSessions.length > 0 ? 'flex' : 'none';

			if (visibleSessions.length < 2 && archivedSessions.length === 0) {
				this._setVisible(false);
				return;
			}

			this._setVisible(true);
			this._renderTabs(visibleSessions, activeSession);

			// Move trailing buttons to end
			this._element.appendChild(this._addButton);
			this._element.appendChild(this._showArchivedButton);
		}));
	}

	private _toggleShowArchived(): void {
		this._showArchived = !this._showArchived;
		this._updateShowArchivedButton();

		// Force re-render by reading the current state and re-rendering
		const workItem = this._workItemService.activeWorkItem.get();
		if (!workItem) {
			return;
		}

		const sessions = workItem.sessions.get();
		const activeSessions = sessions.filter(s => !s.isArchived.get());
		const archivedSessions = sessions.filter(s => s.isArchived.get());
		const visibleSessions = this._showArchived ? sessions : activeSessions;
		const activeSession = this._sessionsManagementService.activeSession.get();

		this._showArchivedButton.style.display = archivedSessions.length > 0 ? 'flex' : 'none';

		if (visibleSessions.length < 2 && archivedSessions.length === 0) {
			this._setVisible(false);
			return;
		}

		this._setVisible(true);
		this._renderTabs(visibleSessions, activeSession);

		this._element.appendChild(this._addButton);
		this._element.appendChild(this._showArchivedButton);
	}

	private _updateShowArchivedButton(): void {
		this._showArchivedButton.classList.toggle('active', this._showArchived);
		if (this._showArchived) {
			this._showArchivedButton.title = localize('sessionTabBar.hideArchived', "Hide Archived Sessions");
			this._showArchivedButton.setAttribute('aria-label', localize('sessionTabBar.hideArchived', "Hide Archived Sessions"));
			this._showArchivedButton.setAttribute('aria-pressed', 'true');
		} else {
			this._showArchivedButton.title = localize('sessionTabBar.showArchived', "Show Archived Sessions");
			this._showArchivedButton.setAttribute('aria-label', localize('sessionTabBar.showArchived', "Show Archived Sessions"));
			this._showArchivedButton.setAttribute('aria-pressed', 'false');
		}
		DOM.clearNode(this._showArchivedButton);
		const icon = DOM.append(this._showArchivedButton, $(ThemeIcon.asCSSSelector(Codicon.archive)));
		icon.style.pointerEvents = 'none';
	}

	private _setVisible(visible: boolean): void {
		if (this._visible === visible) {
			return;
		}

		this._visible = visible;
		this._element.style.display = visible ? 'flex' : 'none';
		this._onDidChangeVisibility.fire(visible);
	}

	private _renderTabs(sessions: readonly ISession[], activeSession: ISession | undefined): void {
		this._sessionsDisposables.clear();
		DOM.clearNode(this._tabsContainer);
		const activeWorkItem = this._workItemService.activeWorkItem.get();

		for (const session of sessions) {
			const isArchived = session.isArchived.get();
			const tab = DOM.append(this._tabsContainer, $('div.session-tab'));
			tab.setAttribute('role', 'tab');
			tab.classList.toggle('archived', isArchived);

			const isActive = activeSession?.sessionId === session.sessionId;
			tab.classList.toggle('active', isActive);
			tab.setAttribute('aria-selected', String(isActive));

			// Status icon
			const statusIcon = DOM.append(tab, $('span.session-tab-status'));
			this._sessionsDisposables.add(autorun(reader => {
				const status = session.status.read(reader);
				const icon = this._getStatusIcon(status);
				statusIcon.className = 'session-tab-status ' + ThemeIcon.asClassName(icon);
			}));

			// Title
			const titleEl = DOM.append(tab, $('span.session-tab-title'));
			this._sessionsDisposables.add(autorun(reader => {
				titleEl.textContent = this._getSessionLabel(session.title.read(reader));
			}));

			// Action button: unarchive for archived sessions, close/archive for active ones
			const actionBtn = DOM.append(tab, $('span.session-tab-close'));
			actionBtn.setAttribute('role', 'button');
			if (isArchived) {
				actionBtn.className = 'session-tab-close ' + ThemeIcon.asClassName(Codicon.discard);
				actionBtn.title = localize('sessionTabBar.unarchiveSession', "Restore Session");
				this._sessionsDisposables.add(DOM.addDisposableListener(actionBtn, DOM.EventType.CLICK, (e) => {
					e.stopPropagation();
					this._sessionsManagementService.unarchiveSession(session);
				}));
			} else {
				actionBtn.className = 'session-tab-close ' + ThemeIcon.asClassName(Codicon.close);
				actionBtn.title = localize('sessionTabBar.archiveSession', "Archive Session");
				this._sessionsDisposables.add(DOM.addDisposableListener(actionBtn, DOM.EventType.CLICK, (e) => {
					e.stopPropagation();
					this._archiveSession(session, sessions);
				}));
			}

			// Click tab to switch
			this._sessionsDisposables.add(DOM.addDisposableListener(tab, DOM.EventType.CLICK, () => {
				if (activeWorkItem) {
					this._workItemService.setPreferredSessionForWorkItem(activeWorkItem.id, session.sessionId);
				}
				this._sessionsManagementService.openSession(this._getSessionOpenTarget(session));
			}));
		}
	}

	private async _archiveSession(session: ISession, allVisibleSessions: readonly ISession[]): Promise<void> {
		const activeSession = this._sessionsManagementService.activeSession.get();
		const isActive = activeSession?.sessionId === session.sessionId;

		// If the archived session was active, switch to the next non-archived session first
		if (isActive) {
			const activeWorkItem = this._workItemService.activeWorkItem.get();
			const nextSession = allVisibleSessions.find(s => s.sessionId !== session.sessionId && !s.isArchived.get());
			if (nextSession && activeWorkItem) {
				this._workItemService.setPreferredSessionForWorkItem(activeWorkItem.id, nextSession.sessionId);
				this._sessionsManagementService.openSession(this._getSessionOpenTarget(nextSession));
			}
		}

		await this._sessionsManagementService.archiveSession(session);
	}

	private _getSessionOpenTarget(session: ISession): ISession | URI {
		if (session.status.get() === SessionStatus.Untitled || session.loading.get()) {
			return session;
		}

		return session.resource;
	}

	private _getSessionLabel(title: string): string {
		return title || localize('sessionTabBar.untitledSession', "New Session");
	}

	private _getStatusIcon(status: SessionStatus): ThemeIcon {
		switch (status) {
			case SessionStatus.InProgress: return Codicon.loading;
			case SessionStatus.NeedsInput: return Codicon.bellDot;
			case SessionStatus.Completed: return Codicon.check;
			case SessionStatus.Error: return Codicon.error;
			default: return Codicon.circle;
		}
	}

	private async _onAddSession(): Promise<void> {
		const workItem = this._workItemService.activeWorkItem.get();
		if (!workItem) {
			return;
		}

		await this._workItemService.createSessionForWorkItem(workItem.id);
	}
}
