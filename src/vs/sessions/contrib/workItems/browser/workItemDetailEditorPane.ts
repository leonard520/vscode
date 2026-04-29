/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/workItemDetail.css';
import * as DOM from '../../../../base/browser/dom.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, observableValue } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { URI } from '../../../../base/common/uri.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { IWorkItemService } from '../../../services/workItems/common/workItemService.js';
import { IWorkItem, IWorkItemDiscussion, WorkItemPriority, WorkItemStatus } from '../../../services/workItems/common/workItem.js';
import { IGitHubService } from '../../github/browser/githubService.js';
import { IGitHubIssueComment } from '../../github/common/types.js';
import { WorkItemEditorInput, WORK_ITEM_EDITOR_ID } from './workItemEditorInput.js';

const $ = DOM.$;

/**
 * Editor pane that displays work item detail: header (editable priority/labels),
 * editable description, GitHub issue discussion (comments), and a reply box.
 */
export class WorkItemDetailEditorPane extends EditorPane {

	static readonly ID = WORK_ITEM_EDITOR_ID;

	private container!: HTMLElement;
	private readonly inputDisposables = this._register(new DisposableStore());
	private readonly renderDisposables = this._register(new MutableDisposable<DisposableStore>());

	private readonly comments = observableValue<readonly IGitHubIssueComment[]>('comments', []);
	private readonly isLoadingComments = observableValue<boolean>('isLoadingComments', false);
	private commentsCts: CancellationTokenSource | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkItemService private readonly workItemService: IWorkItemService,
		@IGitHubService private readonly githubService: IGitHubService,
		@IMarkdownRendererService private readonly markdownRendererService: IMarkdownRendererService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
	) {
		super(WorkItemDetailEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = DOM.append(parent, $('.work-item-detail-editor'));
	}

	override async setInput(input: WorkItemEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (token.isCancellationRequested) {
			return;
		}

		this.inputDisposables.clear();
		this.comments.set([], undefined);

		const workItem = this.workItemService.getWorkItem(input.workItemId);
		if (!workItem) {
			return;
		}

		this.renderWorkItem(workItem);
		this.fetchComments(workItem);
	}

	override clearInput(): void {
		this.inputDisposables.clear();
		this.renderDisposables.clear();
		DOM.clearNode(this.container);
		this.commentsCts?.cancel();
		super.clearInput();
	}

	override layout(dimension: DOM.Dimension): void {
		if (this.container) {
			this.container.style.width = `${dimension.width}px`;
			this.container.style.height = `${dimension.height}px`;
		}
	}

	override focus(): void {
		super.focus();
		this.container?.focus();
	}

	// --- Render ---

	private renderWorkItem(workItem: IWorkItem): void {
		DOM.clearNode(this.container);
		const disposables = new DisposableStore();
		this.renderDisposables.value = disposables;

		this.renderHeader(workItem, disposables);
		this.renderDescription(workItem, disposables);
		this.renderDiscussion(workItem, disposables);
	}

	private renderHeader(workItem: IWorkItem, disposables: DisposableStore): void {
		const header = DOM.append(this.container, $('.work-item-detail-header'));

		// Title row — click to edit
		const titleRow = DOM.append(header, $('.work-item-detail-title-row'));
		const titleEl = DOM.append(titleRow, $('span.work-item-detail-title.editable'));
		const statusBadge = DOM.append(titleRow, $('span.work-item-detail-status-badge'));

		disposables.add(autorun(reader => {
			titleEl.textContent = workItem.title.read(reader);
		}));

		disposables.add(DOM.addDisposableListener(titleEl, DOM.EventType.CLICK, () => {
			this.editTitle(workItem);
		}));

		disposables.add(autorun(reader => {
			const status = workItem.status.read(reader);
			const isOpen = status === WorkItemStatus.Open;
			statusBadge.textContent = isOpen
				? localize('workItemDetail.open', "Open")
				: localize('workItemDetail.closed', "Closed");
			statusBadge.classList.toggle('open', isOpen);
			statusBadge.classList.toggle('closed', !isOpen);
		}));

		// Click status badge to toggle
		disposables.add(DOM.addDisposableListener(statusBadge, DOM.EventType.CLICK, () => {
			const newStatus = workItem.status.get() === WorkItemStatus.Open
				? WorkItemStatus.Closed
				: WorkItemStatus.Open;
			this.workItemService.updateWorkItem(workItem.id, { status: newStatus });
		}));
		statusBadge.classList.add('editable');

		// Meta row
		const meta = DOM.append(header, $('.work-item-detail-meta'));

		// Priority — click to change
		const priorityItem = DOM.append(meta, $('span.work-item-detail-meta-item.editable'));
		DOM.append(priorityItem, $('span' + ThemeIcon.asCSSSelector(Codicon.flame)));
		const priorityLabel = DOM.append(priorityItem, $('span'));
		disposables.add(autorun(reader => {
			const p = workItem.priority.read(reader);
			priorityLabel.textContent = this.priorityDisplayName(p);
		}));
		disposables.add(DOM.addDisposableListener(priorityItem, DOM.EventType.CLICK, () => {
			this.editPriority(workItem);
		}));

		// Labels — click to edit
		const labelsItem = DOM.append(meta, $('span.work-item-detail-meta-item.editable'));
		DOM.append(labelsItem, $('span' + ThemeIcon.asCSSSelector(Codicon.tag)));
		const labelsContainer = DOM.append(labelsItem, $('span'));
		disposables.add(autorun(reader => {
			DOM.clearNode(labelsContainer);
			const labels = workItem.labels.read(reader);
			if (labels.length === 0) {
				const empty = DOM.append(labelsContainer, $('span.work-item-detail-empty-text'));
				empty.textContent = localize('workItemDetail.addLabels', "Add labels");
			} else {
				for (const label of labels) {
					const badge = DOM.append(labelsContainer, $('span.work-item-detail-label'));
					badge.textContent = label;
				}
			}
		}));
		disposables.add(DOM.addDisposableListener(labelsItem, DOM.EventType.CLICK, () => {
			this.editLabels(workItem);
		}));

		// Linked issue
		disposables.add(autorun(reader => {
			const linked = workItem.linkedIssue.read(reader);
			const existing = header.querySelector('.work-item-detail-issue-link-container');
			existing?.remove();

			if (linked) {
				const linkContainer = DOM.append(meta, $('span.work-item-detail-meta-item.work-item-detail-issue-link-container'));
				DOM.append(linkContainer, $('span' + ThemeIcon.asCSSSelector(Codicon.github)));
				const link = DOM.append(linkContainer, $('a.work-item-detail-issue-link'));
				link.textContent = `${linked.owner}/${linked.repo}#${linked.number}`;
				disposables.add(DOM.addDisposableListener(link, DOM.EventType.CLICK, (e) => {
					DOM.EventHelper.stop(e);
					this.openerService.open(URI.parse(linked.url));
				}));
			}
		}));

		// Timestamps
		const timeItem = DOM.append(meta, $('span.work-item-detail-meta-item'));
		disposables.add(autorun(reader => {
			const updated = workItem.updatedAt.read(reader);
			timeItem.textContent = localize('workItemDetail.updated', "Updated {0}", fromNow(updated, true));
		}));
	}

	private renderDescription(workItem: IWorkItem, disposables: DisposableStore): void {
		const section = DOM.append(this.container, $('.work-item-detail-section'));
		const sectionHeader = DOM.append(section, $('.work-item-detail-section-header'));
		DOM.append(sectionHeader, $('span.work-item-detail-section-title')).textContent =
			localize('workItemDetail.description', "Description");

		// Edit button in section header
		const editBtn = DOM.append(sectionHeader, $('button.work-item-detail-refresh-button'));
		DOM.append(editBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.edit)));
		DOM.append(editBtn, document.createTextNode(localize('workItemDetail.edit', "Edit")));

		const descBody = DOM.append(section, $('.work-item-detail-description'));
		const renderedDisposable = disposables.add(new MutableDisposable());

		// Textarea for editing (hidden by default)
		const editContainer = DOM.append(section, $('.work-item-detail-description-edit'));
		editContainer.style.display = 'none';
		const textarea = DOM.append(editContainer, $('textarea.work-item-detail-description-textarea')) as HTMLTextAreaElement;
		textarea.placeholder = localize('workItemDetail.descriptionPlaceholder', "Write a description (Markdown supported)...");

		const editActions = DOM.append(editContainer, $('.work-item-detail-reply-actions'));
		const saveBtn = DOM.append(editActions, $('button.work-item-detail-reply-button')) as HTMLButtonElement;
		saveBtn.textContent = localize('workItemDetail.save', "Save");
		const cancelBtn = DOM.append(editActions, $('button.work-item-detail-cancel-button')) as HTMLButtonElement;
		cancelBtn.textContent = localize('workItemDetail.cancel', "Cancel");

		let isEditing = false;

		const showView = () => {
			isEditing = false;
			descBody.style.display = '';
			editContainer.style.display = 'none';
		};

		const showEdit = () => {
			isEditing = true;
			textarea.value = workItem.description.get();
			descBody.style.display = 'none';
			editContainer.style.display = '';
			textarea.focus();
		};

		// Render markdown description (reactive)
		disposables.add(autorun(reader => {
			const description = workItem.description.read(reader);
			DOM.clearNode(descBody);
			renderedDisposable.clear();

			if (description) {
				const md = new MarkdownString(description, { supportHtml: false });
				const rendered = this.markdownRendererService.render(md);
				renderedDisposable.value = rendered;
				descBody.appendChild(rendered.element);
			} else {
				const empty = DOM.append(descBody, $('span.work-item-detail-empty-text'));
				empty.textContent = localize('workItemDetail.noDescription', "No description. Click Edit to add one.");
			}
		}));

		// Click description body to edit
		disposables.add(DOM.addDisposableListener(descBody, DOM.EventType.CLICK, () => {
			if (!isEditing) {
				showEdit();
			}
		}));
		descBody.classList.add('editable');

		disposables.add(DOM.addDisposableListener(editBtn, DOM.EventType.CLICK, () => {
			if (isEditing) {
				showView();
			} else {
				showEdit();
			}
		}));

		disposables.add(DOM.addDisposableListener(saveBtn, DOM.EventType.CLICK, () => {
			this.workItemService.updateWorkItem(workItem.id, { description: textarea.value });
			showView();
		}));

		disposables.add(DOM.addDisposableListener(cancelBtn, DOM.EventType.CLICK, () => {
			showView();
		}));
	}

	private renderDiscussion(workItem: IWorkItem, disposables: DisposableStore): void {
		const section = DOM.append(this.container, $('.work-item-detail-section'));

		// Section header
		const sectionHeader = DOM.append(section, $('.work-item-detail-section-header'));
		DOM.append(sectionHeader, $('span.work-item-detail-section-title')).textContent =
			localize('workItemDetail.discussion', "Discussion");

		const discussionBody = DOM.append(section, $('.work-item-detail-discussion'));

		// --- Local discussions (generated from sessions) ---
		const localContainer = DOM.append(discussionBody, $('div.work-item-detail-local-discussions'));
		const localRenderDisposables = disposables.add(new MutableDisposable<DisposableStore>());

		disposables.add(autorun(reader => {
			const discussions = workItem.discussions.read(reader);
			DOM.clearNode(localContainer);
			const localDisp = new DisposableStore();
			localRenderDisposables.value = localDisp;

			for (const discussion of discussions) {
				this.renderLocalDiscussion(localContainer, workItem, discussion, localDisp);
			}
		}));

		// --- GitHub comments (if linked) ---
		const linked = workItem.linkedIssue.get();
		if (linked) {
			const ghHeader = DOM.append(discussionBody, $('.work-item-detail-gh-section-header'));
			DOM.append(ghHeader, $('span' + ThemeIcon.asCSSSelector(Codicon.github)));
			DOM.append(ghHeader, $('span')).textContent =
				localize('workItemDetail.githubComments', "GitHub Comments");

			const refreshBtn = DOM.append(ghHeader, $('button.work-item-detail-refresh-button'));
			DOM.append(refreshBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.refresh)));
			DOM.append(refreshBtn, document.createTextNode(localize('workItemDetail.refresh', "Refresh")));
			disposables.add(DOM.addDisposableListener(refreshBtn, DOM.EventType.CLICK, () => {
				this.fetchComments(workItem);
			}));

			// Loading indicator
			const loadingEl = DOM.append(discussionBody, $('.work-item-detail-loading'));
			DOM.append(loadingEl, $('span' + ThemeIcon.asCSSSelector(Codicon.loading) + '.codicon-modifier-spin'));
			DOM.append(loadingEl, document.createTextNode(localize('workItemDetail.loading', "Loading comments...")));

			disposables.add(autorun(reader => {
				const loading = this.isLoadingComments.read(reader);
				loadingEl.style.display = loading ? '' : 'none';
			}));

			// Comments list
			const commentsContainer = DOM.append(discussionBody, $('div'));
			const commentRenderDisposables = disposables.add(new MutableDisposable<DisposableStore>());

			disposables.add(autorun(reader => {
				const commentList = this.comments.read(reader);
				const loading = this.isLoadingComments.read(reader);
				DOM.clearNode(commentsContainer);
				const commentDisp = new DisposableStore();
				commentRenderDisposables.value = commentDisp;

				if (commentList.length === 0 && !loading) {
					const empty = DOM.append(commentsContainer, $('span.work-item-detail-empty-text'));
					empty.textContent = localize('workItemDetail.noComments', "No comments yet.");
					return;
				}

				for (const comment of commentList) {
					this.renderComment(commentsContainer, comment, commentDisp);
				}
			}));

			// Reply box
			this.renderReplyBox(section, workItem, disposables);
		}
	}

	private renderLocalDiscussion(
		parent: HTMLElement,
		workItem: IWorkItem,
		discussion: IWorkItemDiscussion,
		disposables: DisposableStore,
	): void {
		const el = DOM.append(parent, $('.work-item-detail-comment.work-item-detail-local-discussion'));

		// Header
		const header = DOM.append(el, $('.work-item-detail-comment-header'));
		DOM.append(header, $('span' + ThemeIcon.asCSSSelector(Codicon.commentDiscussion)));
		const author = DOM.append(header, $('span.work-item-detail-comment-author'));
		author.textContent = localize('workItemDetail.generatedSummary', "Generated Summary");

		const time = DOM.append(header, $('span.work-item-detail-comment-time'));
		time.textContent = fromNow(new Date(discussion.createdAt), true);

		if (discussion.syncedToGitHub) {
			const syncedBadge = DOM.append(header, $('span.work-item-detail-synced-badge'));
			DOM.append(syncedBadge, $('span' + ThemeIcon.asCSSSelector(Codicon.check)));
			DOM.append(syncedBadge, document.createTextNode(localize('workItemDetail.synced', "Synced")));
		}

		// Body — rendered markdown
		const body = DOM.append(el, $('.work-item-detail-comment-body'));
		const md = new MarkdownString(discussion.body, { supportHtml: false });
		const rendered = this.markdownRendererService.render(md);
		disposables.add(rendered);
		body.appendChild(rendered.element);

		// Actions row
		const actions = DOM.append(el, $('.work-item-detail-discussion-actions'));

		// Edit button — opens editable textarea
		const editBtn = DOM.append(actions, $('button.work-item-detail-action-button')) as HTMLButtonElement;
		DOM.append(editBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.edit)));
		DOM.append(editBtn, document.createTextNode(localize('workItemDetail.edit', "Edit")));

		// Edit container (hidden by default)
		const editContainer = DOM.append(el, $('.work-item-detail-description-edit'));
		editContainer.style.display = 'none';
		const textarea = DOM.append(editContainer, $('textarea.work-item-detail-description-textarea')) as HTMLTextAreaElement;
		const editActions = DOM.append(editContainer, $('.work-item-detail-reply-actions'));
		const saveBtn = DOM.append(editActions, $('button.work-item-detail-reply-button')) as HTMLButtonElement;
		saveBtn.textContent = localize('workItemDetail.save', "Save");
		const cancelBtn = DOM.append(editActions, $('button.work-item-detail-cancel-button')) as HTMLButtonElement;
		cancelBtn.textContent = localize('workItemDetail.cancel', "Cancel");

		disposables.add(DOM.addDisposableListener(editBtn, DOM.EventType.CLICK, () => {
			textarea.value = discussion.body;
			body.style.display = 'none';
			actions.style.display = 'none';
			editContainer.style.display = '';
			textarea.focus();
		}));

		disposables.add(DOM.addDisposableListener(saveBtn, DOM.EventType.CLICK, () => {
			this.workItemService.updateDiscussion(workItem.id, discussion.id, { body: textarea.value });
			editContainer.style.display = 'none';
			body.style.display = '';
			actions.style.display = '';
		}));

		disposables.add(DOM.addDisposableListener(cancelBtn, DOM.EventType.CLICK, () => {
			editContainer.style.display = 'none';
			body.style.display = '';
			actions.style.display = '';
		}));

		// Sync to GitHub button (only if linked and not yet synced)
		const linked = workItem.linkedIssue.get();
		if (linked && !discussion.syncedToGitHub) {
			const syncBtn = DOM.append(actions, $('button.work-item-detail-action-button')) as HTMLButtonElement;
			DOM.append(syncBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.github)));
			DOM.append(syncBtn, document.createTextNode(localize('workItemDetail.syncToGitHub', "Sync to GitHub")));

			disposables.add(DOM.addDisposableListener(syncBtn, DOM.EventType.CLICK, async () => {
				syncBtn.disabled = true;
				try {
					await this.githubService.createIssueComment(
						linked.owner,
						linked.repo,
						linked.number,
						discussion.body,
					);
					this.workItemService.updateDiscussion(workItem.id, discussion.id, { syncedToGitHub: true });
					// Refresh GitHub comments to show the new one
					await this.fetchCommentsAsync(workItem);
				} catch {
					syncBtn.disabled = false;
				}
			}));
		}
	}

	private renderComment(parent: HTMLElement, comment: IGitHubIssueComment, disposables: DisposableStore): void {
		const el = DOM.append(parent, $('.work-item-detail-comment'));

		// Header: avatar, author, association, time
		const header = DOM.append(el, $('.work-item-detail-comment-header'));

		if (comment.user.avatarUrl) {
			const avatar = DOM.append(header, $('img.work-item-detail-comment-avatar')) as HTMLImageElement;
			avatar.src = comment.user.avatarUrl;
			avatar.alt = comment.user.login;
		}

		const author = DOM.append(header, $('span.work-item-detail-comment-author'));
		author.textContent = comment.user.login;

		if (comment.authorAssociation && comment.authorAssociation !== 'NONE') {
			const assoc = DOM.append(header, $('span.work-item-detail-comment-association'));
			assoc.textContent = comment.authorAssociation.toLowerCase();
		}

		const time = DOM.append(header, $('span.work-item-detail-comment-time'));
		time.textContent = fromNow(new Date(comment.createdAt), true);

		// Body
		const body = DOM.append(el, $('.work-item-detail-comment-body'));
		const md = new MarkdownString(comment.body, { supportHtml: false });
		const rendered = this.markdownRendererService.render(md);
		disposables.add(rendered);
		body.appendChild(rendered.element);
	}

	private renderReplyBox(parent: HTMLElement, workItem: IWorkItem, disposables: DisposableStore): void {
		const linked = workItem.linkedIssue.get();
		if (!linked) {
			return;
		}

		const replyContainer = DOM.append(parent, $('.work-item-detail-reply'));
		const textarea = DOM.append(replyContainer, $('textarea')) as HTMLTextAreaElement;
		textarea.placeholder = localize('workItemDetail.replyPlaceholder', "Leave a comment...");

		const actions = DOM.append(replyContainer, $('.work-item-detail-reply-actions'));
		const submitBtn = DOM.append(actions, $('button.work-item-detail-reply-button')) as HTMLButtonElement;
		submitBtn.textContent = localize('workItemDetail.comment', "Comment");

		const updateButtonState = () => {
			submitBtn.disabled = !textarea.value.trim();
		};
		updateButtonState();

		disposables.add(DOM.addDisposableListener(textarea, DOM.EventType.INPUT, () => {
			updateButtonState();
		}));

		disposables.add(DOM.addDisposableListener(submitBtn, DOM.EventType.CLICK, async () => {
			const body = textarea.value.trim();
			if (!body) {
				return;
			}

			submitBtn.disabled = true;
			textarea.disabled = true;

			try {
				await this.githubService.createIssueComment(linked.owner, linked.repo, linked.number, body);
				textarea.value = '';
				// Refresh comments after posting
				await this.fetchCommentsAsync(workItem);
			} finally {
				textarea.disabled = false;
				updateButtonState();
			}
		}));
	}

	// --- Inline editing ---

	private async editTitle(workItem: IWorkItem): Promise<void> {
		const title = await this.quickInputService.input({
			value: workItem.title.get(),
			placeHolder: localize('workItemDetail.editTitlePlaceholder', "Work item title"),
			prompt: localize('workItemDetail.editTitlePrompt', "Update the work item title"),
		});

		if (title !== undefined) {
			this.workItemService.updateWorkItem(workItem.id, { title });
		}
	}

	private async editPriority(workItem: IWorkItem): Promise<void> {
		const current = workItem.priority.get();
		const items = [
			{ label: localize('workItemDetail.priority.focus', "Focus"), id: WorkItemPriority.Focus, description: current === WorkItemPriority.Focus ? localize('workItemDetail.current', "(current)") : undefined },
			{ label: localize('workItemDetail.priority.upNext', "Up Next"), id: WorkItemPriority.UpNext, description: current === WorkItemPriority.UpNext ? localize('workItemDetail.current', "(current)") : undefined },
			{ label: localize('workItemDetail.priority.backlog', "Backlog"), id: WorkItemPriority.Backlog, description: current === WorkItemPriority.Backlog ? localize('workItemDetail.current', "(current)") : undefined },
		];

		const pick = await this.quickInputService.pick(items, {
			placeHolder: localize('workItemDetail.selectPriority', "Select priority"),
		});

		if (pick) {
			this.workItemService.updateWorkItem(workItem.id, { priority: (pick as typeof items[0]).id });
		}
	}

	private async editLabels(workItem: IWorkItem): Promise<void> {
		const currentLabels = workItem.labels.get();

		// Collect all known labels from other work items for suggestions
		const knownSet = new Set<string>();
		for (const item of this.workItemService.getWorkItems()) {
			for (const label of item.labels.get()) {
				knownSet.add(label);
			}
		}
		const knownLabels = [...knownSet].sort((a, b) => a.localeCompare(b));
		const currentSet = new Set(currentLabels);

		interface ILabelItem { label: string; labelValue: string; picked?: boolean }
		const items: ILabelItem[] = knownLabels.map(l => ({
			label: l,
			labelValue: l,
			picked: currentSet.has(l),
		}));

		const picker = this.quickInputService.createQuickPick<ILabelItem>();
		const disposables = new DisposableStore();

		picker.canSelectMany = true;
		picker.placeholder = localize('workItemDetail.pickLabels', "Select labels or type to create new ones");
		picker.items = items;
		picker.selectedItems = items.filter(i => i.picked);

		disposables.add(picker.onDidChangeValue(value => {
			const trimmed = value.trim();
			const exists = !trimmed || knownLabels.some(l => l.toLowerCase() === trimmed.toLowerCase());
			const previouslySelected = new Set(picker.selectedItems.map(i => i.labelValue));

			if (exists) {
				picker.items = items;
			} else {
				const createItem: ILabelItem = {
					label: localize('workItemDetail.createLabel', "Create \"{0}\"", trimmed),
					labelValue: trimmed,
				};
				picker.items = [createItem, ...items];
			}
			picker.selectedItems = picker.items.filter(i => previouslySelected.has(i.labelValue));
		}));

		const result = await new Promise<string[] | undefined>(resolve => {
			let didAccept = false;
			disposables.add(picker.onDidAccept(() => {
				didAccept = true;
				resolve(picker.selectedItems.map(i => i.labelValue));
				picker.hide();
			}));
			disposables.add(picker.onDidHide(() => {
				if (!didAccept) {
					resolve(undefined);
				}
				disposables.dispose();
			}));
			picker.show();
		});

		if (result !== undefined) {
			this.workItemService.updateWorkItem(workItem.id, { labels: result });
		}
	}

	private priorityDisplayName(priority: WorkItemPriority): string {
		switch (priority) {
			case WorkItemPriority.Focus: return localize('workItemDetail.priorityFocus', "Focus");
			case WorkItemPriority.UpNext: return localize('workItemDetail.priorityUpNext', "Up Next");
			case WorkItemPriority.Backlog: return localize('workItemDetail.priorityBacklog', "Backlog");
		}
	}

	// --- Data ---

	private fetchComments(workItem: IWorkItem): void {
		this.fetchCommentsAsync(workItem);
	}

	private async fetchCommentsAsync(workItem: IWorkItem): Promise<void> {
		const linked = workItem.linkedIssue.get();
		if (!linked) {
			return;
		}

		this.commentsCts?.cancel();
		const cts = new CancellationTokenSource();
		this.commentsCts = cts;
		this.isLoadingComments.set(true, undefined);

		try {
			const result = await this.githubService.getIssueComments(linked.owner, linked.repo, linked.number);
			if (!cts.token.isCancellationRequested) {
				this.comments.set(result, undefined);
			}
		} finally {
			if (!cts.token.isCancellationRequested) {
				this.isLoadingComments.set(false, undefined);
			}
		}
	}

	override dispose(): void {
		this.commentsCts?.cancel();
		super.dispose();
	}
}
