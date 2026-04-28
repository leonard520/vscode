/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/workItemsList.css';
import * as DOM from '../../../../base/browser/dom.js';
import { IListVirtualDelegate, ListDragOverEffectPosition, ListDragOverEffectType } from '../../../../base/browser/ui/list/list.js';
import { ITreeContextMenuEvent, ITreeDragAndDrop, ITreeDragOverReaction, ITreeNode, ITreeRenderer, ITreeFilter, TreeDragOverBubble, TreeVisibility } from '../../../../base/browser/ui/tree/tree.js';
import { IDragAndDropData } from '../../../../base/browser/dnd.js';
import { Separator } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { fromNow } from '../../../../base/common/date.js';
import { localize } from '../../../../nls.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { WorkbenchObjectTree } from '../../../../platform/list/browser/listService.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { basename } from '../../../../base/common/resources.js';
import { Menus } from '../../../browser/menus.js';
import { ActiveWorkItemHasLinkedIssueContext, ActiveWorkItemHasWorkingDirectoryContext, ActiveWorkItemPriorityContext, ActiveWorkItemSessionCountContext, ActiveWorkItemStatusContext, HasActiveWorkItemContext } from '../../../common/contextkeys.js';
import { IWorkItem, WorkItemPriority, WorkItemStatus } from '../../../services/workItems/common/workItem.js';
import { IWorkItemService } from '../../../services/workItems/common/workItemService.js';
import { CountBadge } from '../../../../base/browser/ui/countBadge/countBadge.js';
import { defaultCountBadgeStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { ListViewTargetSector } from '../../../../base/browser/ui/list/listView.js';

const $ = DOM.$;

//#region Types

export interface IWorkItemSection {
	readonly id: string;
	readonly label: string;
	readonly priority: WorkItemPriority | 'closed';
	readonly items: readonly IWorkItem[];
	readonly count: number;
}

export type WorkItemListElement = IWorkItem | IWorkItemSection;

function isSection(element: WorkItemListElement): element is IWorkItemSection {
	return 'items' in element;
}

export function getWorkItemSessionSummary(sessionTitles: readonly string[]): string | undefined {
	if (sessionTitles.length === 0) {
		return undefined;
	}

	if (sessionTitles.length === 1) {
		return sessionTitles[0];
	}

	const visibleTitles = sessionTitles.slice(0, 2);
	if (sessionTitles.length === visibleTitles.length) {
		return localize('workItem.sessionSummary', "{0} sessions: {1}", sessionTitles.length, visibleTitles.join(', '));
	}

	return localize('workItem.sessionSummaryWithOverflow', "{0} sessions: {1} +{2} more", sessionTitles.length, visibleTitles.join(', '), sessionTitles.length - visibleTitles.length);
}

function getWorkItemAriaLabel(item: IWorkItem): string {
	const summary = getWorkItemSessionSummary(item.sessions.get().map(session => session.title.get() || localize('workItem.untitledSession', "New Session")));
	return summary ? localize('workItem.ariaLabelWithSessions', "{0}, {1}", item.title.get(), summary) : item.title.get();
}

/**
 * Matches a work item against a filter string by checking title, labels,
 * status, priority, and linked issue.
 */
function matchesFilter(item: IWorkItem, filterText: string): boolean {
	const lower = filterText.toLowerCase();
	const title = item.title.get().toLowerCase();
	if (title.includes(lower)) {
		return true;
	}
	const labels = item.labels.get();
	for (const label of labels) {
		if (label.toLowerCase().includes(lower)) {
			return true;
		}
	}
	const status = item.status.get().toLowerCase();
	if (status.includes(lower)) {
		return true;
	}
	const priority = item.priority.get().toLowerCase();
	if (priority.includes(lower)) {
		return true;
	}
	const linkedIssue = item.linkedIssue.get();
	if (linkedIssue) {
		const issueText = `#${linkedIssue.number} ${linkedIssue.owner}/${linkedIssue.repo}`.toLowerCase();
		if (issueText.includes(lower)) {
			return true;
		}
	}
	return false;
}

//#endregion

//#region Filter

class WorkItemsFilter implements ITreeFilter<WorkItemListElement> {
	private _filterText = '';

	set filterText(value: string) {
		this._filterText = value.trim();
	}

	get filterText(): string {
		return this._filterText;
	}

	filter(element: WorkItemListElement): TreeVisibility {
		if (!this._filterText) {
			return TreeVisibility.Visible;
		}
		if (isSection(element)) {
			return TreeVisibility.Recurse;
		}
		return matchesFilter(element, this._filterText)
			? TreeVisibility.Visible
			: TreeVisibility.Hidden;
	}
}

//#endregion

//#region Delegate

class WorkItemsTreeDelegate implements IListVirtualDelegate<WorkItemListElement> {
	getHeight(element: WorkItemListElement): number {
		return isSection(element) ? 26 : 44;
	}

	getTemplateId(element: WorkItemListElement): string {
		return isSection(element) ? WorkItemSectionRenderer.TEMPLATE_ID : WorkItemRowRenderer.TEMPLATE_ID;
	}
}

//#endregion

//#region Section Renderer

interface IWorkItemSectionTemplate {
	readonly container: HTMLElement;
	readonly label: HTMLElement;
	readonly badge: CountBadge;
}

class WorkItemSectionRenderer implements ITreeRenderer<IWorkItemSection, void, IWorkItemSectionTemplate> {
	static readonly TEMPLATE_ID = 'workItemSection';
	readonly templateId = WorkItemSectionRenderer.TEMPLATE_ID;

	renderTemplate(container: HTMLElement): IWorkItemSectionTemplate {
		const el = DOM.append(container, $('.work-item-section-header'));
		const label = DOM.append(el, $('span.work-item-section-label'));
		const badgeContainer = DOM.append(el, $('span.work-item-section-badge'));
		const badge = new CountBadge(badgeContainer, {}, defaultCountBadgeStyles);
		return { container: el, label, badge };
	}

	renderElement(node: ITreeNode<IWorkItemSection, void>, _index: number, templateData: IWorkItemSectionTemplate): void {
		templateData.label.textContent = node.element.label;
		templateData.badge.setCount(node.element.count);
	}

	disposeTemplate(_templateData: IWorkItemSectionTemplate): void { }
}

//#endregion

//#region Row Renderer

interface IWorkItemRowTemplate {
	readonly container: HTMLElement;
	readonly statusIcon: HTMLElement;
	readonly title: HTMLElement;
	readonly toolbar: MenuWorkbenchToolBar;
	readonly description: HTMLElement;
	readonly issueBadge: HTMLElement;
	readonly workingDir: HTMLElement;
	readonly labelsContainer: HTMLElement;
	readonly time: HTMLElement;
	readonly unreadIndicator: HTMLElement;
	readonly hasActiveWorkItemContext: IContextKey<boolean>;
	readonly hasLinkedIssueContext: IContextKey<boolean>;
	readonly hasWorkingDirectoryContext: IContextKey<boolean>;
	readonly statusContext: IContextKey<string>;
	readonly priorityContext: IContextKey<string>;
	readonly sessionCountContext: IContextKey<number>;
	readonly elementDisposables: DisposableStore;
	readonly disposables: DisposableStore;
}

class WorkItemRowRenderer implements ITreeRenderer<IWorkItem, void, IWorkItemRowTemplate> {
	static readonly TEMPLATE_ID = 'workItemRow';
	readonly templateId = WorkItemRowRenderer.TEMPLATE_ID;

	constructor(
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IHoverService private readonly _hoverService: IHoverService,
	) { }

	renderTemplate(container: HTMLElement): IWorkItemRowTemplate {
		const disposables = new DisposableStore();
		const elementDisposables = disposables.add(new DisposableStore());

		const row = DOM.append(container, $('.work-item-row'));

		// Main row: status icon + title + toolbar
		const mainRow = DOM.append(row, $('.work-item-main'));
		const statusIcon = DOM.append(mainRow, $('.work-item-status-icon' + ThemeIcon.asCSSSelector(Codicon.circle)));
		const title = DOM.append(mainRow, $('span.work-item-title'));
		const toolbarContainer = DOM.append(mainRow, $('.work-item-toolbar'));
		const contextKeyService = disposables.add(this._contextKeyService.createScoped(toolbarContainer));
		const scopedInstantiationService = disposables.add(this._instantiationService.createChild(new ServiceCollection([IContextKeyService, contextKeyService])));
		const toolbar = disposables.add(scopedInstantiationService.createInstance(MenuWorkbenchToolBar, toolbarContainer, Menus.WorkItemToolbar, {
			hiddenItemStrategy: HiddenItemStrategy.NoHide,
			menuOptions: { shouldForwardArgs: true },
		}));

		// Unread indicator dot
		const unreadIndicator = DOM.append(mainRow, $('span.work-item-unread-indicator'));

		// Description row: issue badge + labels + time
		const descRow = DOM.append(row, $('.work-item-desc'));
		const issueBadge = DOM.append(descRow, $('span.work-item-issue-badge'));
		const description = DOM.append(descRow, $('span.work-item-description'));
		const workingDir = DOM.append(descRow, $('span.work-item-working-dir'));
		const labelsContainer = DOM.append(descRow, $('span.work-item-labels'));
		const time = DOM.append(descRow, $('span.work-item-time'));

		return {
			container: row,
			statusIcon,
			title,
			toolbar,
			description,
			issueBadge,
			workingDir,
			labelsContainer,
			time,
			unreadIndicator,
			hasActiveWorkItemContext: HasActiveWorkItemContext.bindTo(contextKeyService),
			hasLinkedIssueContext: ActiveWorkItemHasLinkedIssueContext.bindTo(contextKeyService),
			hasWorkingDirectoryContext: ActiveWorkItemHasWorkingDirectoryContext.bindTo(contextKeyService),
			statusContext: ActiveWorkItemStatusContext.bindTo(contextKeyService),
			priorityContext: ActiveWorkItemPriorityContext.bindTo(contextKeyService),
			sessionCountContext: ActiveWorkItemSessionCountContext.bindTo(contextKeyService),
			elementDisposables,
			disposables,
		};
	}

	renderElement(node: ITreeNode<IWorkItem, void>, _index: number, templateData: IWorkItemRowTemplate): void {
		const item = node.element;
		templateData.elementDisposables.clear();
		templateData.toolbar.context = item;

		// Status icon
		templateData.elementDisposables.add(autorun(reader => {
			const status = item.status.read(reader);
			const isOpen = status === WorkItemStatus.Open;
			const iconClass = isOpen ? Codicon.circle.classNames : Codicon.pass.classNames;
			templateData.statusIcon.className = 'work-item-status-icon ' + iconClass;
			templateData.statusIcon.classList.toggle('open', isOpen);
			templateData.statusIcon.classList.toggle('closed', !isOpen);
		}));

		// Title
		templateData.elementDisposables.add(autorun(reader => {
			templateData.title.textContent = item.title.read(reader);
		}));

		// Issue badge
		templateData.elementDisposables.add(autorun(reader => {
			const linkedIssue = item.linkedIssue.read(reader);
			if (linkedIssue) {
				templateData.issueBadge.textContent = `${linkedIssue.owner}/${linkedIssue.repo}#${linkedIssue.number}`;
				templateData.issueBadge.style.display = '';
			} else {
				templateData.issueBadge.style.display = 'none';
			}
		}));

		// Description: sessions summary
		templateData.elementDisposables.add(autorun(reader => {
			const sessions = item.sessions.read(reader);
			const count = sessions.length;
			if (count > 0) {
				templateData.description.textContent = count === 1
					? localize('workItem.oneSession', "1 session")
					: localize('workItem.nSessions', "{0} sessions", count);
				templateData.description.style.display = '';
			} else {
				templateData.description.style.display = 'none';
			}
		}));

		// Working directory
		templateData.elementDisposables.add(autorun(reader => {
			const workDir = item.workingDirectory.read(reader);
			if (workDir) {
				const folderName = basename(workDir);
				templateData.workingDir.textContent = folderName;
				templateData.workingDir.title = workDir.fsPath;
				templateData.workingDir.style.display = '';
			} else {
				templateData.workingDir.style.display = 'none';
			}
		}));

		// Labels
		templateData.elementDisposables.add(autorun(reader => {
			const labels = item.labels.read(reader);
			DOM.clearNode(templateData.labelsContainer);
			for (const label of labels.slice(0, 2)) {
				const badge = DOM.append(templateData.labelsContainer, $('span.work-item-label'));
				badge.textContent = label;
			}
			if (labels.length > 2) {
				const more = DOM.append(templateData.labelsContainer, $('span.work-item-label.more'));
				more.textContent = `+${labels.length - 2}`;
			}
		}));

		// Time
		templateData.elementDisposables.add(autorun(reader => {
			const updatedAt = item.updatedAt.read(reader);
			templateData.time.textContent = fromNow(updatedAt, true);
		}));

		// Hover tooltip — show description on hover
		const hoverDisposable = templateData.elementDisposables.add(new MutableDisposable());
		templateData.elementDisposables.add(autorun(reader => {
			const desc = item.description.read(reader);
			if (desc) {
				hoverDisposable.value = this._hoverService.setupDelayedHover(templateData.container, { content: desc });
			} else {
				hoverDisposable.clear();
			}
		}));

		// Unread state — highlight when any session is unread
		templateData.elementDisposables.add(autorun(reader => {
			const sessions = item.sessions.read(reader);
			const hasUnread = sessions.some(s => !s.isRead.read(reader));
			templateData.container.classList.toggle('has-unread', hasUnread);
			templateData.unreadIndicator.style.display = hasUnread ? '' : 'none';
		}));

		// Context keys
		templateData.elementDisposables.add(autorun(reader => {
			templateData.hasActiveWorkItemContext.set(true);
			templateData.hasLinkedIssueContext.set(!!item.linkedIssue.read(reader));
			templateData.hasWorkingDirectoryContext.set(!!item.workingDirectory.read(reader));
			templateData.statusContext.set(item.status.read(reader));
			templateData.priorityContext.set(item.priority.read(reader));
			templateData.sessionCountContext.set(item.sessions.read(reader).length);
		}));
	}

	disposeTemplate(templateData: IWorkItemRowTemplate): void {
		templateData.disposables.dispose();
	}
}

//#endregion

//#region Drag and Drop

class WorkItemsDragAndDrop implements ITreeDragAndDrop<WorkItemListElement> {

	constructor(
		private readonly _workItemService: IWorkItemService,
	) { }

	getDragURI(element: WorkItemListElement): string | null {
		if (isSection(element)) {
			return null;
		}
		return element.id;
	}

	getDragLabel(elements: WorkItemListElement[]): string | undefined {
		const items = elements.filter((e): e is IWorkItem => !isSection(e));
		if (items.length === 1) {
			return items[0].title.get();
		}
		return items.length > 1 ? String(items.length) : undefined;
	}

	onDragOver(data: IDragAndDropData, targetElement: WorkItemListElement | undefined, _targetIndex: number | undefined, _targetSector: ListViewTargetSector | undefined, _originalEvent: DragEvent): boolean | ITreeDragOverReaction {
		if (!targetElement) {
			return false;
		}

		// Only accept internal work item drags
		const draggedItems = data.getData() as WorkItemListElement[];
		if (!draggedItems || draggedItems.length === 0) {
			return false;
		}

		const hasWorkItems = draggedItems.some(e => !isSection(e));
		if (!hasWorkItems) {
			return false;
		}

		// Drop onto a section header: accept and highlight the whole section
		if (isSection(targetElement)) {
			return {
				accept: true,
				bubble: TreeDragOverBubble.Down,
				effect: { type: ListDragOverEffectType.Move, position: ListDragOverEffectPosition.Over },
			};
		}

		// Drop onto a work item row: bubble up to the parent section
		return {
			accept: true,
			bubble: TreeDragOverBubble.Up,
			effect: { type: ListDragOverEffectType.Move, position: ListDragOverEffectPosition.Over },
		};
	}

	drop(data: IDragAndDropData, targetElement: WorkItemListElement | undefined, _targetIndex: number | undefined, _targetSector: ListViewTargetSector | undefined, _originalEvent: DragEvent): void {
		if (!targetElement) {
			return;
		}

		// Resolve the target section: either the section itself, or derive from
		// the target work item's current priority/status (bubble-up from row to section)
		let targetSection: IWorkItemSection | undefined;
		if (isSection(targetElement)) {
			targetSection = targetElement;
		} else {
			const targetPriority = targetElement.status.get() === WorkItemStatus.Closed
				? 'closed' as const
				: targetElement.priority.get();
			targetSection = { id: '', label: '', priority: targetPriority, items: [], count: 0 };
		}
		if (!targetSection) {
			return;
		}

		const draggedItems = (data.getData() as WorkItemListElement[]).filter((e): e is IWorkItem => !isSection(e));
		if (draggedItems.length === 0) {
			return;
		}

		for (const item of draggedItems) {
			if (targetSection.priority === 'closed') {
				// Dropping into Closed section: close the work item
				this._workItemService.updateWorkItem(item.id, { status: WorkItemStatus.Closed });
			} else {
				// Dropping into a priority section: reopen if closed, update priority
				const changes: { status?: WorkItemStatus; priority?: WorkItemPriority } = {
					priority: targetSection.priority,
				};
				if (item.status.get() === WorkItemStatus.Closed) {
					changes.status = WorkItemStatus.Open;
				}
				this._workItemService.updateWorkItem(item.id, changes);
			}
		}
	}

	dispose(): void { }
}

//#endregion

//#region WorkItemsList

export class WorkItemsList extends Disposable {

	private _tree: WorkbenchObjectTree<WorkItemListElement> | undefined;
	private readonly _filter = new WorkItemsFilter();
	private _totalCount = 0;
	private _filteredCount = 0;

	constructor(
		private readonly _container: HTMLElement,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IWorkItemService private readonly _workItemService: IWorkItemService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@IMenuService private readonly _menuService: IMenuService,
		@IContextMenuService private readonly _contextMenuService: IContextMenuService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super();
	}

	create(): void {
		this._container.classList.add('work-items-list');

		this._tree = this._register(this._instantiationService.createInstance(
			WorkbenchObjectTree<WorkItemListElement>,
			'WorkItemsList',
			this._container,
			new WorkItemsTreeDelegate(),
			[
				new WorkItemSectionRenderer(),
				this._instantiationService.createInstance(WorkItemRowRenderer),
			],
			{
				identityProvider: {
					getId: (element: WorkItemListElement) => isSection(element) ? `section:${element.id}` : element.id,
				},
				accessibilityProvider: {
					getAriaLabel: (element: WorkItemListElement) => {
						if (isSection(element)) {
							return element.label;
						}
						return getWorkItemAriaLabel(element);
					},
					getWidgetAriaLabel: () => localize('workItemsList', "Work Items"),
				},
				filter: this._filter,
				dnd: new WorkItemsDragAndDrop(this._workItemService),
			}
		));

		// Selection handler
		this._register(this._tree.onDidChangeSelection(e => {
			const element = e.elements[0];
			if (element && !isSection(element)) {
				this._workItemService.setActiveWorkItem(element.id);
			}
		}));

		// Double-click opens detail editor
		this._register(this._tree.onDidOpen(e => {
			const element = e.element;
			if (element && !isSection(element) && e.browserEvent?.type === 'dblclick') {
				this._commandService.executeCommand('workItems.openDetail', element);
			}
		}));

		this._register(this._tree.onContextMenu(e => this._onContextMenu(e)));
		this._register(autorun(reader => {
			const active = this._workItemService.activeWorkItem.read(reader);
			if (!this._tree) {
				return;
			}

			this._syncActiveWorkItem(active);
		}));

		this._refresh();

		// Refresh on data changes
		this._register(this._workItemService.onDidChangeWorkItems(() => this._refresh()));
	}

	setFilter(filterText: string): void {
		this._filter.filterText = filterText;
		this._tree?.refilter();
		this._updateFilterStats();
	}

	getFilterStats(): { total: number; filtered: number } {
		return { total: this._totalCount, filtered: this._filteredCount };
	}

	focus(): void {
		this._tree?.domFocus();
	}

	private _refresh(): void {
		if (!this._tree) {
			return;
		}

		const items = this._workItemService.getWorkItems();
		this._totalCount = items.length;
		const sections = this._buildSections(items);

		const children = sections.map(section => ({
			element: section as WorkItemListElement,
			children: section.items.map(item => ({
				element: item as WorkItemListElement,
			})),
			collapsed: section.id === 'backlog' || section.id === 'closed',
		}));

		this._tree.setChildren(null, children);
		this._updateFilterStats();

		const active = this._workItemService.activeWorkItem.get();
		this._syncActiveWorkItem(active);
	}

	private _updateFilterStats(): void {
		if (!this._filter.filterText) {
			this._filteredCount = this._totalCount;
			return;
		}
		const items = this._workItemService.getWorkItems();
		this._filteredCount = items.filter(item => matchesFilter(item, this._filter.filterText)).length;
	}

	private _syncActiveWorkItem(active: IWorkItem | undefined): void {
		if (!this._tree) {
			return;
		}

		if (!active || !this._tree.hasElement(active)) {
			this._tree.setSelection([]);
			this._tree.setFocus([]);
			return;
		}

		this._tree.setSelection([active]);
		this._tree.setFocus([active]);
	}

	private _buildSections(items: readonly IWorkItem[]): IWorkItemSection[] {
		const focus: IWorkItem[] = [];
		const upNext: IWorkItem[] = [];
		const backlog: IWorkItem[] = [];
		const closed: IWorkItem[] = [];

		for (const item of items) {
			if (item.status.get() === WorkItemStatus.Closed) {
				closed.push(item);
				continue;
			}
			switch (item.priority.get()) {
				case WorkItemPriority.Focus: focus.push(item); break;
				case WorkItemPriority.UpNext: upNext.push(item); break;
				case WorkItemPriority.Backlog: backlog.push(item); break;
			}
		}

		const sortByUpdated = (a: IWorkItem, b: IWorkItem) =>
			b.updatedAt.get().getTime() - a.updatedAt.get().getTime();

		focus.sort(sortByUpdated);
		upNext.sort(sortByUpdated);
		backlog.sort(sortByUpdated);
		closed.sort(sortByUpdated);

		const sections: IWorkItemSection[] = [
			{ id: 'focus', label: localize('workItem.priority.focus', "Focus"), priority: WorkItemPriority.Focus, items: focus, count: focus.length },
			{ id: 'up-next', label: localize('workItem.priority.upNext', "Up Next"), priority: WorkItemPriority.UpNext, items: upNext, count: upNext.length },
			{ id: 'backlog', label: localize('workItem.priority.backlog', "Backlog"), priority: WorkItemPriority.Backlog, items: backlog, count: backlog.length },
			{ id: 'closed', label: localize('workItem.status.closed', "Closed"), priority: 'closed', items: closed, count: closed.length },
		];

		return sections;
	}

	private _onContextMenu(e: ITreeContextMenuEvent<WorkItemListElement | null>): void {
		const element = e.element;
		if (!element || isSection(element)) {
			return;
		}

		const contextOverlay: [string, string | boolean | number][] = [
			[HasActiveWorkItemContext.key, true],
			[ActiveWorkItemHasLinkedIssueContext.key, !!element.linkedIssue.get()],
			[ActiveWorkItemHasWorkingDirectoryContext.key, !!element.workingDirectory.get()],
			[ActiveWorkItemStatusContext.key, element.status.get()],
			[ActiveWorkItemPriorityContext.key, element.priority.get()],
			[ActiveWorkItemSessionCountContext.key, element.sessions.get().length],
		];

		const menu = this._menuService.createMenu(Menus.WorkItemContextMenu, this._contextKeyService.createOverlay(contextOverlay));
		this._contextMenuService.showContextMenu({
			getActions: () => Separator.join(...menu.getActions({ arg: element, shouldForwardArgs: true }).map(([, actions]) => actions)),
			getAnchor: () => e.anchor,
			getKeyBinding: action => this._keybindingService.lookupKeybinding(action.id) ?? undefined,
		});
		menu.dispose();
	}

	layout(height: number, width: number): void {
		this._tree?.layout(height, width);
	}
}

//#endregion
