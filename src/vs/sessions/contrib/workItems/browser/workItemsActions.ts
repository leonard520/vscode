/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { URI } from '../../../../base/common/uri.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IWorkItem, WorkItemPriority, WorkItemStatus } from '../../../services/workItems/common/workItem.js';
import { IWorkItemService } from '../../../services/workItems/common/workItemService.js';
import { IGitHubRepoConfig, IWorkItemGitHubConfigService } from '../../../services/workItems/common/githubConfig.js';
import { IGitHubService } from '../../github/browser/githubService.js';
import { IGitHubIssue } from '../../github/common/types.js';
import { HasActiveWorkItemContext, ActiveWorkItemHasLinkedIssueContext, ActiveWorkItemSessionCountContext } from '../../../common/contextkeys.js';
import { Menus } from '../../../browser/menus.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { WorkItemEditorInput } from './workItemEditorInput.js';
import { WorkItemSummaryEditorInput } from './workItemSummaryEditorInput.js';
import { SummaryMode, SummaryTimeRange } from './workItemSummaryGenerator.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IWorkItemSyncService } from './workItemSyncService.js';

const WORK_ITEMS_CATEGORY = localize2('workItems.category', "Work Items");

interface IGitHubIssueQuickPickItem extends IQuickPickItem {
	readonly issue: IGitHubIssue;
}

interface IWorkItemPriorityQuickPickItem extends IQuickPickItem {
	readonly id: WorkItemPriority;
}

interface IRepositoryQuickPickItem extends IQuickPickItem {
	readonly owner: string;
	readonly repo: string;
}

function isWorkItem(arg: unknown): arg is IWorkItem {
	return typeof arg === 'object' && arg !== null && typeof (arg as IWorkItem).id === 'string';
}

function getTargetWorkItem(workItemService: IWorkItemService, arg?: unknown): IWorkItem | undefined {
	if (isWorkItem(arg)) {
		return workItemService.getWorkItem(arg.id) ?? arg;
	}

	return workItemService.activeWorkItem.get();
}

function parseIssueNumberInput(value: string): number | undefined {
	const match = /^\s*#?(\d+)\s*$/.exec(value);
	if (!match) {
		return undefined;
	}

	const issueNumber = parseInt(match[1], 10);
	return isNaN(issueNumber) ? undefined : issueNumber;
}

function createGitHubIssuePick(issue: IGitHubIssue): IGitHubIssueQuickPickItem {
	return {
		label: `#${issue.number} ${issue.title}`,
		description: issue.labels.map(label => label.name).join(', '),
		issue,
	};
}

async function pickGitHubIssue(
	quickInputService: IQuickInputService,
	githubService: IGitHubService,
	owner: string,
	repo: string,
): Promise<IGitHubIssue | undefined> {
	const picker = quickInputService.createQuickPick<IGitHubIssueQuickPickItem>();
	const disposables = new DisposableStore();
	const cachedIssues = new Map<number, IGitHubIssue>();
	const pendingExactLookups = new Set<number>();
	let loadingOperations = 0;

	const setBusy = (delta: number) => {
		loadingOperations += delta;
		picker.busy = loadingOperations > 0;
	};

	const updateItems = () => {
		picker.items = [...cachedIssues.values()]
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
			.map(createGitHubIssuePick);
	};

	picker.placeholder = localize('workItems.selectIssue', "Select issue to link");
	picker.matchOnDescription = true;
	picker.sortByLabel = false;
	picker.show();

	setBusy(1);
	void githubService.getAssignedIssues(owner, repo).then(issues => {
		for (const issue of issues) {
			cachedIssues.set(issue.number, issue);
		}
		updateItems();
		const exactIssueNumber = parseIssueNumberInput(picker.value);
		if (exactIssueNumber !== undefined && cachedIssues.has(exactIssueNumber)) {
			picker.activeItems = [createGitHubIssuePick(cachedIssues.get(exactIssueNumber)!)];
		}
	}).finally(() => {
		setBusy(-1);
	});

	disposables.add(picker.onDidChangeValue(value => {
		const issueNumber = parseIssueNumberInput(value);
		if (issueNumber === undefined || cachedIssues.has(issueNumber) || pendingExactLookups.has(issueNumber)) {
			return;
		}

		pendingExactLookups.add(issueNumber);
		setBusy(1);
		void githubService.getIssue(owner, repo, issueNumber).then(issue => {
			cachedIssues.set(issue.number, issue);
			updateItems();
			picker.activeItems = [createGitHubIssuePick(issue)];
		}).finally(() => {
			pendingExactLookups.delete(issueNumber);
			setBusy(-1);
		});
	}));

	const pickedIssue = await new Promise<IGitHubIssue | undefined>(resolve => {
		let didAccept = false;

		disposables.add(picker.onDidAccept(() => {
			didAccept = true;
			const [selected] = picker.selectedItems;
			picker.hide();
			resolve(selected?.issue);
		}));

		disposables.add(picker.onDidHide(() => {
			if (!didAccept) {
				resolve(undefined);
			}
		}));
	});

	disposables.dispose();
	return pickedIssue;
}

async function ensureConfiguredRepos(
	quickInputService: IQuickInputService,
	githubConfigService: IWorkItemGitHubConfigService,
): Promise<readonly IGitHubRepoConfig[]> {
	let repos = githubConfigService.getRepos();
	if (repos.length > 0) {
		return repos;
	}

	const add = await quickInputService.input({
		placeHolder: localize('workItems.addRepoFirst', "owner/repo"),
		prompt: localize('workItems.addRepoPrompt', "No GitHub repos configured. Enter owner/repo to add one."),
	});

	if (!add) {
		return repos;
	}

	const parts = add.split('/');
	if (parts.length === 2) {
		await githubConfigService.addRepo(parts[0].trim(), parts[1].trim());
		repos = githubConfigService.getRepos();
	}

	return repos;
}

async function pickRepository(
	quickInputService: IQuickInputService,
	githubConfigService: IWorkItemGitHubConfigService,
	placeHolder: string,
): Promise<IRepositoryQuickPickItem | undefined> {
	const repos = await ensureConfiguredRepos(quickInputService, githubConfigService);
	if (repos.length === 0) {
		return undefined;
	}

	return quickInputService.pick<IRepositoryQuickPickItem>(
		repos.map(repo => ({ label: repo.fullName, owner: repo.owner, repo: repo.repo })),
		{ placeHolder }
	);
}

// -- Edit Work Item (removed — editing is now handled by the detail editor pane) --

// -- Create Work Item --

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workItems.create',
			title: localize2('workItems.create', "New Work Item"),
			category: WORK_ITEMS_CATEGORY,
			icon: Codicon.add,
			menu: [{
				id: Menus.WorkItemsViewTitle,
				group: 'navigation',
				order: 1,
			}],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const workItemService = accessor.get(IWorkItemService);

		const title = await quickInputService.input({
			placeHolder: localize('workItems.newTitle', "Work item title"),
			prompt: localize('workItems.newPrompt', "Enter a title for the new work item"),
		});

		if (!title) {
			return;
		}

		const item = workItemService.createWorkItem({ title, priority: WorkItemPriority.Backlog });
		workItemService.setActiveWorkItem(item.id);
	}
});

// -- Close / Reopen Work Item --

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workItems.toggleStatus',
			title: localize2('workItems.toggleStatus', "Close/Reopen Work Item"),
			category: WORK_ITEMS_CATEGORY,
			icon: Codicon.issueReopened,
			menu: [{
				id: Menus.WorkItemContextMenu,
				group: '1_actions',
				order: 1,
			}, {
				id: Menus.WorkItemToolbar,
				group: 'navigation',
				order: 0,
			}],
			precondition: HasActiveWorkItemContext,
		});
	}

	async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
		const workItemService = accessor.get(IWorkItemService);
		const githubService = accessor.get(IGitHubService);
		const quickInputService = accessor.get(IQuickInputService);

		const active = getTargetWorkItem(workItemService, arg);
		if (!active) {
			return;
		}

		const newStatus = active.status.get() === WorkItemStatus.Open
			? WorkItemStatus.Closed
			: WorkItemStatus.Open;

		const linked = active.linkedIssue.get();

		// When closing a work item with a linked issue, prompt for an optional comment
		let closeComment: string | undefined;
		if (newStatus === WorkItemStatus.Closed && linked) {
			const comment = await quickInputService.input({
				placeHolder: localize('workItems.closeCommentPlaceholder', "Optional comment for closing the linked issue"),
				prompt: localize('workItems.closeCommentPrompt', "Add a comment to {0}/{1}#{2} (press Enter to skip)", linked.owner, linked.repo, linked.number),
			});

			// undefined means the user pressed Escape — cancel the close
			if (comment === undefined) {
				return;
			}

			closeComment = comment || undefined;
		}

		workItemService.updateWorkItem(active.id, { status: newStatus });

		// Sync to GitHub if linked
		if (linked) {
			if (closeComment) {
				await githubService.createIssueComment(linked.owner, linked.repo, linked.number, closeComment);
			}

			await githubService.updateIssue(linked.owner, linked.repo, linked.number, {
				state: newStatus === WorkItemStatus.Open ? 'open' : 'closed',
			});
		}
	}
});

// -- Change Priority --

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workItems.changePriority',
			title: localize2('workItems.changePriority', "Change Priority"),
			category: WORK_ITEMS_CATEGORY,
			menu: [{
				id: Menus.WorkItemContextMenu,
				group: '1_actions',
				order: 2,
			}],
			precondition: HasActiveWorkItemContext,
		});
	}

	async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const workItemService = accessor.get(IWorkItemService);

		const active = getTargetWorkItem(workItemService, arg);
		if (!active) {
			return;
		}

		const pick = await quickInputService.pick<IWorkItemPriorityQuickPickItem>(
			[
				{ label: localize('workItem.priority.focus', "Focus"), id: WorkItemPriority.Focus },
				{ label: localize('workItem.priority.upNext', "Up Next"), id: WorkItemPriority.UpNext },
				{ label: localize('workItem.priority.backlog', "Backlog"), id: WorkItemPriority.Backlog },
			],
			{ placeHolder: localize('workItems.priorityPlaceholder', "Select priority") }
		);

		if (pick) {
			workItemService.updateWorkItem(active.id, { priority: pick.id });
		}
	}
});

// -- Set Working Directory --

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workItems.setWorkingDirectory',
			title: localize2('workItems.setWorkingDirectory', "Set Working Directory"),
			category: WORK_ITEMS_CATEGORY,
			icon: Codicon.folderOpened,
			menu: [{
				id: Menus.WorkItemContextMenu,
				group: '1_actions',
				order: 0,
			}],
			precondition: HasActiveWorkItemContext,
		});
	}

	async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
		const fileDialogService = accessor.get(IFileDialogService);
		const workItemService = accessor.get(IWorkItemService);

		const active = getTargetWorkItem(workItemService, arg);
		if (!active) {
			return;
		}

		const folder = await fileDialogService.showOpenDialog({
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: false,
			title: localize('workItems.selectFolder', "Select Working Directory"),
		});

		if (folder && folder.length > 0) {
			workItemService.updateWorkItem(active.id, { workingDirectory: folder[0] });
		}
	}
});

// -- Link GitHub Issue --

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workItems.linkGitHubIssue',
			title: localize2('workItems.linkGitHubIssue', "Link GitHub Issue"),
			category: WORK_ITEMS_CATEGORY,
			icon: Codicon.link,
			menu: [{
				id: Menus.WorkItemContextMenu,
				group: '2_config',
				order: 2,
			}],
			precondition: ContextKeyExpr.and(HasActiveWorkItemContext, ActiveWorkItemHasLinkedIssueContext.toNegated()),
		});
	}

	async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const workItemService = accessor.get(IWorkItemService);
		const githubConfigService = accessor.get(IWorkItemGitHubConfigService);
		const githubService = accessor.get(IGitHubService);

		const active = getTargetWorkItem(workItemService, arg);
		if (!active) {
			return;
		}

		const repoPick = await pickRepository(
			quickInputService,
			githubConfigService,
			localize('workItems.selectRepo', "Select repository")
		);
		if (!repoPick) {
			return;
		}

		const { owner, repo } = repoPick;

		const issue = await pickGitHubIssue(quickInputService, githubService, owner, repo);
		if (!issue) {
			return;
		}

		workItemService.updateWorkItem(active.id, {
			linkedIssue: {
				owner,
				repo,
				number: issue.number,
				url: issue.htmlUrl,
			},
			title: issue.title,
			description: issue.body,
			labels: issue.labels.map(l => l.name),
			status: issue.state === 'open' ? WorkItemStatus.Open : WorkItemStatus.Closed,
		});
	}
});

// -- Create GitHub Issue from Work Item --

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workItems.createGitHubIssue',
			title: localize2('workItems.createGitHubIssue', "Create GitHub Issue"),
			category: WORK_ITEMS_CATEGORY,
			icon: Codicon.add,
			menu: [{
				id: Menus.WorkItemContextMenu,
				group: '2_config',
				order: 3,
			}],
			precondition: ContextKeyExpr.and(HasActiveWorkItemContext, ActiveWorkItemHasLinkedIssueContext.toNegated()),
		});
	}

	async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const workItemService = accessor.get(IWorkItemService);
		const githubConfigService = accessor.get(IWorkItemGitHubConfigService);
		const githubService = accessor.get(IGitHubService);

		const active = getTargetWorkItem(workItemService, arg);
		if (!active) {
			return;
		}

		const repoPick = await pickRepository(
			quickInputService,
			githubConfigService,
			localize('workItems.selectTargetRepo', "Select repository to create issue in")
		);
		if (!repoPick) {
			return;
		}

		const { owner, repo } = repoPick;

		const issue = await githubService.createIssue(
			owner,
			repo,
			active.title.get(),
			active.description.get(),
			[...active.labels.get()],
		);

		workItemService.updateWorkItem(active.id, {
			linkedIssue: {
				owner,
				repo,
				number: issue.number,
				url: issue.htmlUrl,
			},
		});
	}
});

// -- Open Linked Issue in Browser --

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workItems.openLinkedIssue',
			title: localize2('workItems.openLinkedIssue', "Open Issue in Browser"),
			category: WORK_ITEMS_CATEGORY,
			menu: [{
				id: Menus.WorkItemContextMenu,
				group: '3_navigate',
				order: 1,
			}],
			precondition: ActiveWorkItemHasLinkedIssueContext,
		});
	}

	async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
		const openerService = accessor.get(IOpenerService);
		const workItemService = accessor.get(IWorkItemService);

		const active = getTargetWorkItem(workItemService, arg);
		const linked = active?.linkedIssue.get();
		if (linked) {
			await openerService.open(URI.parse(linked.url));
		}
	}
});

// -- New Session for Work Item --

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workItems.newSession',
			title: localize2('workItems.newSession', "New Agent Session"),
			category: WORK_ITEMS_CATEGORY,
			icon: Codicon.commentAdd,
			menu: [{
				id: Menus.WorkItemToolbar,
				group: 'navigation',
				order: 4,
			}, {
				id: Menus.WorkItemContextMenu,
				group: '3_navigate',
				order: 1,
			}],
			precondition: HasActiveWorkItemContext,
		});
	}

	async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
		const workItemService = accessor.get(IWorkItemService);

		const active = getTargetWorkItem(workItemService, arg);
		if (!active) {
			return;
		}

		await workItemService.createSessionForWorkItem(active.id);
	}
});

// -- Delete Work Item --

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workItems.openDetail',
			title: localize2('workItems.openDetail', "Open Work Item Detail"),
			category: WORK_ITEMS_CATEGORY,
			icon: Codicon.openPreview,
			menu: [{
				id: Menus.WorkItemContextMenu,
				group: '3_navigate',
				order: 0,
			}],
			precondition: HasActiveWorkItemContext,
		});
	}

	async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const workItemService = accessor.get(IWorkItemService);

		const active = getTargetWorkItem(workItemService, arg);
		if (!active) {
			return;
		}

		const input = new WorkItemEditorInput(active.id);
		await editorService.openEditor(input);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workItems.delete',
			title: localize2('workItems.delete', "Delete Work Item"),
			category: WORK_ITEMS_CATEGORY,
			menu: [{
				id: Menus.WorkItemContextMenu,
				group: '4_danger',
				order: 1,
			}],
			precondition: HasActiveWorkItemContext,
		});
	}

	async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
		const workItemService = accessor.get(IWorkItemService);

		const active = getTargetWorkItem(workItemService, arg);
		if (!active) {
			return;
		}

		workItemService.deleteWorkItem(active.id);
	}
});

// -- Configure GitHub Repos --

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workItems.configureGitHubRepos',
			title: localize2('workItems.configureGitHubRepos', "Configure GitHub Repositories"),
			category: WORK_ITEMS_CATEGORY,
			icon: Codicon.gear,
			menu: [{
				id: Menus.WorkItemsViewTitle,
				group: 'navigation',
				order: 2,
			}],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const githubConfigService = accessor.get(IWorkItemGitHubConfigService);

		const existingRepos = githubConfigService.getRepos();
		const items: IQuickPickItem[] = [
			{ label: localize('workItems.addRepo', "$(add) Add Repository"), id: '__add__' } as any,
			...existingRepos.map(r => ({
				label: r.fullName,
				description: localize('workItems.removeHint', "Select to remove"),
				id: `${r.owner}/${r.repo}`,
			})),
		];

		const pick = await quickInputService.pick(items, {
			placeHolder: localize('workItems.configReposPlaceholder', "Manage GitHub repositories"),
		});

		if (!pick) {
			return;
		}

		if ((pick as any).id === '__add__') {
			const input = await quickInputService.input({
				placeHolder: localize('workItems.addRepoPlaceholder', "owner/repo"),
				prompt: localize('workItems.addRepoPrompt2', "Enter GitHub repository (e.g. microsoft/vscode)"),
			});
			if (input) {
				const parts = input.split('/');
				if (parts.length === 2) {
					await githubConfigService.addRepo(parts[0].trim(), parts[1].trim());
				}
			}
		} else {
			const repo = existingRepos.find(r => r.fullName === (pick as any).id);
			if (repo) {
				githubConfigService.removeRepo(repo.owner, repo.repo);
			}
		}
	}
});

// -- Fetch Assigned GitHub Issues --

interface IGitHubIssueImportQuickPickItem extends IQuickPickItem {
	readonly issue: IGitHubIssue;
	readonly owner: string;
	readonly repo: string;
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workItems.fetchGitHubIssues',
			title: localize2('workItems.fetchGitHubIssues', "Fetch Assigned GitHub Issues"),
			category: WORK_ITEMS_CATEGORY,
			icon: Codicon.refresh,
			menu: [{
				id: Menus.WorkItemsViewTitle,
				group: 'navigation',
				order: 0,
			}],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const workItemService = accessor.get(IWorkItemService);
		const githubConfigService = accessor.get(IWorkItemGitHubConfigService);
		const githubService = accessor.get(IGitHubService);

		const repos = await ensureConfiguredRepos(quickInputService, githubConfigService);
		if (repos.length === 0) {
			return;
		}

		// Build a set of already-linked issue keys so we can filter them out
		const linkedKeys = new Set<string>();
		for (const item of workItemService.getWorkItems()) {
			const linked = item.linkedIssue.get();
			if (linked) {
				linkedKeys.add(`${linked.owner}/${linked.repo}#${linked.number}`);
			}
		}

		// Show picker immediately with busy state for instant feedback
		const picker = quickInputService.createQuickPick<IGitHubIssueImportQuickPickItem>();
		const disposables = new DisposableStore();
		disposables.add(picker);

		picker.placeholder = localize('workItems.loadingIssues', "Loading assigned issues...");
		picker.canSelectMany = true;
		picker.busy = true;
		picker.show();

		const allPicks: IGitHubIssueImportQuickPickItem[] = [];
		let pendingRepos = repos.length;

		const updateItems = () => {
			picker.items = allPicks;
		};

		// Fetch assigned issues from all configured repos in parallel
		await Promise.all(repos.map(async (repoConfig) => {
			try {
				const issues = await githubService.getAssignedIssues(repoConfig.owner, repoConfig.repo);
				for (const issue of issues) {
					const key = `${repoConfig.owner}/${repoConfig.repo}#${issue.number}`;
					if (!linkedKeys.has(key)) {
						allPicks.push({
							label: `#${issue.number} ${issue.title}`,
							description: `${repoConfig.fullName}`,
							detail: issue.labels.map(l => l.name).join(', ') || undefined,
							issue,
							owner: repoConfig.owner,
							repo: repoConfig.repo,
						});
					}
				}
				// Incrementally update picker as each repo completes
				updateItems();
			} finally {
				pendingRepos--;
				if (pendingRepos === 0) {
					picker.busy = false;
					if (allPicks.length === 0) {
						picker.placeholder = localize('workItems.noAssignedIssues', "No new assigned issues found in configured repositories");
					} else {
						picker.placeholder = localize('workItems.selectIssuesToImport', "Select issues to import as work items");
					}
				}
			}
		}));

		const selected = await new Promise<readonly IGitHubIssueImportQuickPickItem[] | undefined>(resolve => {
			let didAccept = false;

			disposables.add(picker.onDidAccept(() => {
				didAccept = true;
				resolve(picker.selectedItems);
				picker.hide();
			}));

			disposables.add(picker.onDidHide(() => {
				if (!didAccept) {
					resolve(undefined);
				}
				disposables.dispose();
			}));
		});

		if (!selected || selected.length === 0) {
			return;
		}

		for (const pick of selected) {
			const item = workItemService.createWorkItem({
				title: pick.issue.title,
				description: pick.issue.body,
				labels: pick.issue.labels.map(l => l.name),
				linkedIssue: {
					owner: pick.owner,
					repo: pick.repo,
					number: pick.issue.number,
					url: pick.issue.htmlUrl,
				},
			});
			workItemService.updateWorkItem(item.id, {
				status: pick.issue.state === 'open' ? WorkItemStatus.Open : WorkItemStatus.Closed,
			});
		}
	}
});

// -- Generate Discussion from Sessions --

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workItems.generateDiscussionFromSessions',
			title: localize2('workItems.generateDiscussionFromSessions', "Generate Discussion from Sessions"),
			category: WORK_ITEMS_CATEGORY,
			icon: Codicon.commentDiscussion,
			menu: [{
				id: Menus.WorkItemContextMenu,
				group: '2_config',
				order: 5,
			}],
			precondition: ContextKeyExpr.and(HasActiveWorkItemContext, ActiveWorkItemSessionCountContext.notEqualsTo(0)),
		});
	}

	async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
		const workItemService = accessor.get(IWorkItemService);
		const syncService = accessor.get(IWorkItemSyncService);
		const notificationService = accessor.get(INotificationService);
		const progressService = accessor.get(IProgressService);

		const active = getTargetWorkItem(workItemService, arg);
		if (!active) {
			return;
		}

		const sessions = active.sessions.get();
		if (sessions.length === 0) {
			notificationService.info(localize('workItems.noSessionsToSummarize', "This work item has no sessions to summarize."));
			return;
		}

		const cts = new CancellationTokenSource();
		const summary = await progressService.withProgress(
			{
				location: ProgressLocation.Notification,
				title: localize('workItems.generatingSummary', "Generating summary from {0} sessions...", sessions.length),
				cancellable: true,
			},
			async (progress) => {
				return syncService.generateSessionSummary(active, cts.token, { progress });
			},
			() => cts.cancel()
		);
		cts.dispose();

		if (summary) {
			workItemService.addDiscussion(active.id, summary);
			notificationService.info(localize('workItems.discussionAdded', "Discussion added from {0} sessions. View it in the work item detail.", sessions.length));
		}
	}
});

// -- Generate Work Summary --

interface ISummaryTimeRangeQuickPickItem extends IQuickPickItem {
	readonly timeRange: SummaryTimeRange;
}

interface ISummaryModeQuickPickItem extends IQuickPickItem {
	readonly mode: SummaryMode;
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workItems.generateSummary',
			title: localize2('workItems.generateSummary', "Generate Work Summary"),
			category: WORK_ITEMS_CATEGORY,
			icon: Codicon.sparkle,
			menu: [{
				id: Menus.WorkItemsViewTitle,
				group: 'navigation',
				order: 3,
			}],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const editorService = accessor.get(IEditorService);

		const timePick = await quickInputService.pick<ISummaryTimeRangeQuickPickItem>(
			[
				{ label: localize('summary.pick.today', "Today"), timeRange: SummaryTimeRange.Today },
				{ label: localize('summary.pick.thisWeek', "This Week"), timeRange: SummaryTimeRange.ThisWeek },
				{ label: localize('summary.pick.thisMonth', "This Month"), timeRange: SummaryTimeRange.ThisMonth },
			],
			{ placeHolder: localize('summary.pick.placeholder', "Select time range for work summary") }
		);

		if (!timePick) {
			return;
		}

		const modePick = await quickInputService.pick<ISummaryModeQuickPickItem>(
			[
				{ label: localize('summary.mode.simple', "Simple"), description: localize('summary.mode.simple.desc', "Brief progress overview — what was worked on and status"), mode: SummaryMode.Simple },
				{ label: localize('summary.mode.detailed', "Detailed"), description: localize('summary.mode.detailed.desc', "Full analysis with decisions, trade-offs, and implementation details"), mode: SummaryMode.Detailed },
			],
			{ placeHolder: localize('summary.mode.placeholder', "Select summary style") }
		);

		if (!modePick) {
			return;
		}

		const input = new WorkItemSummaryEditorInput(timePick.timeRange, modePick.mode);
		await editorService.openEditor(input);
	}
});
