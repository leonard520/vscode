/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatCompositeBar.css';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { $, addDisposableListener, DisposableResizeObserver, EventType, getWindow, reset } from '../../../base/browser/dom.js';
import { autorun } from '../../../base/common/observable.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { PANEL_ACTIVE_TITLE_BORDER, PANEL_ACTIVE_TITLE_FOREGROUND, PANEL_INACTIVE_TITLE_FOREGROUND } from '../../../workbench/common/theme.js';
import { agentsPanelBackground } from '../../common/theme.js';
import { Action } from '../../../base/common/actions.js';
import { ActionBar } from '../../../base/browser/ui/actionbar/actionbar.js';
import { Codicon } from '../../../base/common/codicons.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { StandardMouseEvent } from '../../../base/browser/mouseEvent.js';
import { localize } from '../../../nls.js';
import { IQuickInputService } from '../../../platform/quickinput/common/quickInput.js';
import { IChat, SessionStatus } from '../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../services/sessions/common/sessionsManagement.js';

interface IChatTab {
	readonly chat: IChat;
	readonly element: HTMLElement;
}

/**
 * A composite bar that displays chats within the active agent session as tabs.
 * Selecting a tab loads that chat in the chat view pane instead of switching view containers.
 *
 * Visibility:
 * - Hidden when there are 0 or 1 visible chats AND no archived chats.
 * - Visible when there are 2+ chats, OR when at least one chat is archived
 *   (so the user can always reach the "Show Archived" toggle to restore them).
 */
export class ChatCompositeBar extends Disposable {

	private readonly _container: HTMLElement;
	private readonly _tabsContainer: HTMLElement;
	private readonly _showArchivedButton: HTMLElement;
	private readonly _tabs: IChatTab[] = [];
	private readonly _tabDisposables = this._register(new DisposableStore());

	private readonly _onDidChangeVisibility = this._register(new Emitter<boolean>());
	readonly onDidChangeVisibility: Event<boolean> = this._onDidChangeVisibility.event;

	private _visible = false;
	private _showArchived = false;

	get element(): HTMLElement {
		return this._container;
	}

	get visible(): boolean {
		return this._visible;
	}

	constructor(
		@IThemeService private readonly _themeService: IThemeService,
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
		@IContextMenuService private readonly _contextMenuService: IContextMenuService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
	) {
		super();

		this._container = $('.chat-composite-bar');
		this._tabsContainer = $('.chat-composite-bar-tabs');
		this._container.appendChild(this._tabsContainer);

		this._showArchivedButton = $('.chat-composite-bar-show-archived');
		this._showArchivedButton.setAttribute('role', 'button');
		this._showArchivedButton.tabIndex = 0;
		this._container.appendChild(this._showArchivedButton);
		this._updateShowArchivedButton();
		this._register(addDisposableListener(this._showArchivedButton, EventType.CLICK, () => this._toggleShowArchived()));
		this._register(addDisposableListener(this._showArchivedButton, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this._toggleShowArchived();
			}
		}));

		// Track active session changes
		this._register(autorun(reader => {
			const activeSession = this._sessionsManagementService.activeSession.read(reader);
			if (!activeSession) {
				this._rebuildTabs([], 0, '', undefined);
				return;
			}

			const allChats = activeSession.chats.read(reader);
			const activeChats: IChat[] = [];
			let archivedCount = 0;
			for (const chat of allChats) {
				if (chat.isArchived.read(reader)) {
					archivedCount++;
				} else {
					activeChats.push(chat);
				}
			}

			// When the toggle is on, show all chats (active + archived) so the
			// user can pick an archived one to restore. Otherwise only show
			// active (non-archived) chats.
			const visibleChats = this._showArchived ? allChats : activeChats;
			const activeChatUri = activeSession.activeChat.read(reader)?.resource.toString() ?? '';
			const mainChatUri = activeSession.mainChat.resource.toString();
			this._rebuildTabs(visibleChats, archivedCount, activeChatUri, mainChatUri);
		}));

		// Scroll active tab into view on resize
		const resizeObserver = this._register(new DisposableResizeObserver(() => this._revealActiveTab()));
		this._register(resizeObserver.observe(this._tabsContainer));


		this._updateStyles();
		this._register(this._themeService.onDidColorThemeChange(() => this._updateStyles()));
	}

	private _toggleShowArchived(): void {
		this._showArchived = !this._showArchived;
		this._updateShowArchivedButton();

		// Force re-render from the current state.
		const activeSession = this._sessionsManagementService.activeSession.get();
		if (!activeSession) {
			this._rebuildTabs([], 0, '', undefined);
			return;
		}
		const allChats = activeSession.chats.get();
		const activeChats: IChat[] = [];
		let archivedCount = 0;
		for (const chat of allChats) {
			if (chat.isArchived.get()) {
				archivedCount++;
			} else {
				activeChats.push(chat);
			}
		}
		const visibleChats = this._showArchived ? allChats : activeChats;
		const activeChatUri = activeSession.activeChat.get()?.resource.toString() ?? '';
		const mainChatUri = activeSession.mainChat.resource.toString();
		this._rebuildTabs(visibleChats, archivedCount, activeChatUri, mainChatUri);
	}

	private _updateShowArchivedButton(): void {
		this._showArchivedButton.classList.toggle('active', this._showArchived);
		const label = this._showArchived
			? localize('chatCompositeBar.hideArchived', "Hide Archived Chats")
			: localize('chatCompositeBar.showArchived', "Show Archived Chats");
		this._showArchivedButton.title = label;
		this._showArchivedButton.setAttribute('aria-label', label);
		this._showArchivedButton.setAttribute('aria-pressed', String(this._showArchived));
		reset(this._showArchivedButton);
		const icon = $(ThemeIcon.asCSSSelector(Codicon.archive));
		(icon as HTMLElement).style.pointerEvents = 'none';
		this._showArchivedButton.appendChild(icon);
	}

	private _rebuildTabs(chats: readonly IChat[], archivedCount: number, activeChatId: string, mainChatId?: string): void {
		this._tabDisposables.clear();
		this._tabs.length = 0;
		reset(this._tabsContainer);

		for (const chat of chats) {
			this._createTab(chat, chat.resource.toString() === mainChatId);
		}

		this._updateActiveTab(activeChatId);
		this._updateShowArchivedButtonVisibility(archivedCount);
		this._updateVisibility(chats.length, archivedCount);
	}

	private _updateShowArchivedButtonVisibility(archivedCount: number): void {
		this._showArchivedButton.style.display = archivedCount > 0 ? '' : 'none';
		// Reset the toggle when nothing is archived so a fresh archive doesn't
		// land in the unexpected "showing archived" state.
		if (archivedCount === 0 && this._showArchived) {
			this._showArchived = false;
			this._updateShowArchivedButton();
		}
	}

	private _createTab(chat: IChat, isMainChat: boolean): void {
		const tab = $('.chat-composite-bar-tab');
		tab.tabIndex = 0;
		tab.setAttribute('role', 'tab');

		const labelEl = $('.chat-composite-bar-tab-label');
		this._tabDisposables.add(autorun(reader => {
			const title = chat.title.read(reader);
			labelEl.textContent = title;
		}));
		tab.appendChild(labelEl);

		// Track untitled / archived state for styling.
		this._tabDisposables.add(autorun(reader => {
			const status = chat.status.read(reader);
			tab.classList.toggle('untitled', status === SessionStatus.Untitled);
		}));
		this._tabDisposables.add(autorun(reader => {
			tab.classList.toggle('archived', chat.isArchived.read(reader));
		}));

		// Action button: archived chats get a restore button; non-main, non-archived
		// chats get an archive (X) button. The main chat is never archivable.
		if (chat.isArchived.get()) {
			const restoreAction = this._tabDisposables.add(new Action(
				'chatCompositeBar.unarchiveChat',
				localize('unarchiveChat', "Restore Chat"),
				ThemeIcon.asClassName(Codicon.discard),
				true,
				async () => {
					const session = this._sessionsManagementService.activeSession.get();
					if (session) {
						await this._sessionsManagementService.unarchiveChat(session, chat.resource);
					}
				},
			));
			const actionBar = this._tabDisposables.add(new ActionBar(tab, { actionViewItemProvider: undefined }));
			actionBar.push(restoreAction, { icon: true, label: false });
			actionBar.getContainer().classList.add('chat-composite-bar-tab-actions');
		} else if (!isMainChat) {
			const closeAction = this._tabDisposables.add(new Action(
				'chatCompositeBar.archiveChat',
				localize('archiveChat', "Archive Chat"),
				ThemeIcon.asClassName(Codicon.close),
				true,
				async () => {
					const session = this._sessionsManagementService.activeSession.get();
					if (!session) {
						return;
					}
					// If the chat being archived is currently active, switch
					// to the main chat first so the chat view doesn't keep
					// showing an archived (and now-hidden) chat.
					const activeChatUri = session.activeChat.get()?.resource;
					if (activeChatUri && activeChatUri.toString() === chat.resource.toString()) {
						await this._sessionsManagementService.openChat(session, session.mainChat.resource);
					}
					await this._sessionsManagementService.archiveChat(session, chat.resource);
				},
			));
			const actionBar = this._tabDisposables.add(new ActionBar(tab, { actionViewItemProvider: undefined }));
			actionBar.push(closeAction, { icon: true, label: false });
			actionBar.getContainer().classList.add('chat-composite-bar-tab-actions');
		}

		const indicator = $('.chat-composite-bar-tab-indicator');
		tab.appendChild(indicator);

		this._tabsContainer.appendChild(tab);

		this._tabDisposables.add(addDisposableListener(tab, EventType.CLICK, () => {
			this._onTabClicked(chat);
		}));

		this._tabDisposables.add(addDisposableListener(tab, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this._onTabClicked(chat);
			}
		}));

		const renameAction = this._tabDisposables.add(new Action('sessionCompositeBar.renameChat', localize('renameChat', "Rename"), undefined, true, async () => {
			const newTitle = await this._quickInputService.input({
				value: chat.title.get(),
				prompt: localize('renameChat.prompt', "Rename Chat"),
			});
			if (newTitle) {
				const session = this._sessionsManagementService.activeSession.get();
				if (session) {
					await this._sessionsManagementService.renameChat(session, chat.resource, newTitle);
				}
			}
		}));

		this._tabDisposables.add(addDisposableListener(tab, EventType.CONTEXT_MENU, (e: MouseEvent) => {
			// No context menu for untitled chats
			if (chat.status.get() === SessionStatus.Untitled) {
				e.preventDefault();
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			const event = new StandardMouseEvent(getWindow(tab), e);
			this._contextMenuService.showContextMenu({
				getAnchor: () => event,
				getActions: () => [
					renameAction,
				]
			});
		}));

		this._tabs.push({ chat: chat, element: tab });
	}

	private _onTabClicked(chat: IChat): void {
		const session = this._sessionsManagementService.activeSession.get();
		if (session) {
			this._sessionsManagementService.openChat(session, chat.resource);
		}
	}

	private _updateActiveTab(activeChatId: string): void {
		for (const tab of this._tabs) {
			const isActive = tab.chat.resource.toString() === activeChatId;
			tab.element.classList.toggle('active', isActive);
			tab.element.setAttribute('aria-selected', String(isActive));
			if (isActive) {
				tab.element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
			}
		}
	}

	private _revealActiveTab(): void {
		const activeTab = this._tabs.find(t => t.element.classList.contains('active'));
		activeTab?.element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}

	private _updateVisibility(visibleTabCount: number, archivedCount: number): void {
		// Show when there are multiple chat tabs to switch between, OR when
		// any chat is archived (so the "Show Archived" toggle is reachable).
		const wasVisible = this._visible;
		this._visible = visibleTabCount > 1 || archivedCount > 0;
		this._container.style.display = this._visible ? '' : 'none';
		if (wasVisible !== this._visible) {
			this._onDidChangeVisibility.fire(this._visible);
		}
	}

	private _updateStyles(): void {
		const theme = this._themeService.getColorTheme();

		const bg = theme.getColor(agentsPanelBackground);
		const activeFg = theme.getColor(PANEL_ACTIVE_TITLE_FOREGROUND);
		const inactiveFg = theme.getColor(PANEL_INACTIVE_TITLE_FOREGROUND);
		const activeBorder = theme.getColor(PANEL_ACTIVE_TITLE_BORDER);

		this._container.style.setProperty('--chat-bar-background', bg?.toString() ?? '');
		this._container.style.setProperty('--chat-tab-active-foreground', activeFg?.toString() ?? '');
		this._container.style.setProperty('--chat-tab-inactive-foreground', inactiveFg?.toString() ?? '');
		this._container.style.setProperty('--chat-tab-active-border', activeBorder?.toString() ?? '');
	}
}
