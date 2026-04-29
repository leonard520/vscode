/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/workItemSummary.css';
import * as DOM from '../../../../base/browser/dom.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { ILanguageModelsService } from '../../../../workbench/contrib/chat/common/languageModels.js';
import { IWorkItemService } from '../../../services/workItems/common/workItemService.js';
import { WorkItemSummaryEditorInput, WORK_ITEM_SUMMARY_EDITOR_ID } from './workItemSummaryEditorInput.js';
import {
	collectSummaryInput,
	computeDateRange,
	ISummaryStrategy,
	LLMSummaryStrategy,
	SummaryMode,
	SummaryTimeRange,
	TemplateSummaryStrategy,
} from './workItemSummaryGenerator.js';

const $ = DOM.$;

/**
 * Editor pane that displays a generated work summary.
 * Users select a time range and strategy, then generate a markdown summary.
 */
export class WorkItemSummaryEditorPane extends EditorPane {

	static readonly ID = WORK_ITEM_SUMMARY_EDITOR_ID;

	private container!: HTMLElement;
	private contentContainer!: HTMLElement;
	private loadingContainer!: HTMLElement;
	private emptyContainer!: HTMLElement;
	private copyButton!: HTMLButtonElement;
	private rangeSelect!: HTMLSelectElement;

	private readonly inputDisposables = this._register(new DisposableStore());
	private readonly contentRenderDisposable = this._register(new MutableDisposable());
	private generateCts: CancellationTokenSource | undefined;

	private currentMarkdown: string | undefined;
	private currentTimeRange: SummaryTimeRange = SummaryTimeRange.Today;
	private currentMode: SummaryMode = SummaryMode.Simple;

	private readonly strategies: ISummaryStrategy[];

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkItemService private readonly workItemService: IWorkItemService,
		@IMarkdownRendererService private readonly markdownRendererService: IMarkdownRendererService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@ILogService private readonly logService: ILogService,
	) {
		super(WorkItemSummaryEditorPane.ID, group, telemetryService, themeService, storageService);

		// Register available strategies. LLM strategy is created per-generate based on mode.
		this.strategies = [
			new TemplateSummaryStrategy(),
		];
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = DOM.append(parent, $('.work-item-summary-editor'));

		// Toolbar
		const toolbar = DOM.append(this.container, $('.work-item-summary-toolbar'));

		// Time range selector
		this.rangeSelect = DOM.append(toolbar, $('select')) as HTMLSelectElement;
		this.addRangeOption(SummaryTimeRange.Today, localize('summary.range.today', "Today"));
		this.addRangeOption(SummaryTimeRange.ThisWeek, localize('summary.range.thisWeek', "This Week"));
		this.addRangeOption(SummaryTimeRange.ThisMonth, localize('summary.range.thisMonth', "This Month"));

		this._register(DOM.addDisposableListener(this.rangeSelect, DOM.EventType.CHANGE, () => {
			this.currentTimeRange = this.rangeSelect.value as SummaryTimeRange;
		}));

		// Strategy selector (shown when multiple strategies available)
		if (this.strategies.length > 1) {
			const strategySelect = DOM.append(toolbar, $('select.work-item-summary-strategy-select')) as HTMLSelectElement;
			for (const strategy of this.strategies) {
				const option = document.createElement('option');
				option.value = strategy.id;
				option.textContent = strategy.label;
				strategySelect.appendChild(option);
			}
		}

		// Generate button
		const generateBtn = DOM.append(toolbar, $('button.work-item-summary-generate-button')) as HTMLButtonElement;
		DOM.append(generateBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.sparkle)));
		DOM.append(generateBtn, document.createTextNode(localize('summary.generate', "Generate")));
		this._register(DOM.addDisposableListener(generateBtn, DOM.EventType.CLICK, () => {
			this.generateSummary();
		}));

		// Copy button
		this.copyButton = DOM.append(toolbar, $('button.work-item-summary-copy-button')) as HTMLButtonElement;
		DOM.append(this.copyButton, $('span' + ThemeIcon.asCSSSelector(Codicon.copy)));
		DOM.append(this.copyButton, document.createTextNode(localize('summary.copy', "Copy")));
		this.copyButton.style.display = 'none';
		this._register(DOM.addDisposableListener(this.copyButton, DOM.EventType.CLICK, () => {
			this.copySummary();
		}));

		// Loading indicator
		this.loadingContainer = DOM.append(this.container, $('.work-item-summary-loading'));
		DOM.append(this.loadingContainer, $('span' + ThemeIcon.asCSSSelector(Codicon.loading) + '.codicon-modifier-spin'));
		DOM.append(this.loadingContainer, document.createTextNode(localize('summary.generating', "Generating summary...")));
		this.loadingContainer.style.display = 'none';

		// Empty state
		this.emptyContainer = DOM.append(this.container, $('.work-item-summary-empty'));
		this.emptyContainer.textContent = localize('summary.emptyState', "Select a time range and click Generate to create a work summary.");

		// Content
		this.contentContainer = DOM.append(this.container, $('.work-item-summary-content'));
	}

	override async setInput(input: WorkItemSummaryEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (token.isCancellationRequested) {
			return;
		}

		this.inputDisposables.clear();

		// Apply the time range and mode from the input
		this.currentTimeRange = input.timeRange;
		this.currentMode = input.mode;
		this.rangeSelect.value = input.timeRange;

		// Auto-generate on open
		this.generateSummary();
	}

	override clearInput(): void {
		this.inputDisposables.clear();
		this.contentRenderDisposable.clear();
		this.generateCts?.cancel();
		DOM.clearNode(this.contentContainer);
		this.currentMarkdown = undefined;
		this.copyButton.style.display = 'none';
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

	// --- Generation ---

	private async generateSummary(): Promise<void> {
		// Cancel any in-progress generation
		this.generateCts?.cancel();
		const cts = new CancellationTokenSource();
		this.generateCts = cts;

		// Show loading, hide content
		this.loadingContainer.style.display = '';
		this.emptyContainer.style.display = 'none';
		this.copyButton.style.display = 'none';
		DOM.clearNode(this.contentContainer);
		this.contentRenderDisposable.clear();

		try {
			const { from, to } = computeDateRange(this.currentTimeRange);
			const workItems = this.workItemService.getWorkItems();
			const input = collectSummaryInput(workItems, this.currentTimeRange, from, to);

			// Use LLM strategy for AI synthesis, fall back to template if no model available
			const strategy: ISummaryStrategy = new LLMSummaryStrategy(this.currentMode, this.languageModelsService, this.logService);
			const result = await strategy.generate(input, cts.token);

			if (cts.token.isCancellationRequested) {
				return;
			}

			this.currentMarkdown = result.markdown;
			this.renderMarkdown(result.markdown);
			this.copyButton.style.display = '';
		} catch (e) {
			if (!cts.token.isCancellationRequested) {
				this.renderError(e);
			}
		} finally {
			if (!cts.token.isCancellationRequested) {
				this.loadingContainer.style.display = 'none';
			}
		}
	}

	private renderMarkdown(markdown: string): void {
		DOM.clearNode(this.contentContainer);
		this.contentRenderDisposable.clear();

		const md = new MarkdownString(markdown, { supportHtml: false });
		const rendered = this.markdownRendererService.render(md);
		this.contentRenderDisposable.value = rendered;
		this.contentContainer.appendChild(rendered.element);
	}

	private renderError(error: unknown): void {
		DOM.clearNode(this.contentContainer);
		const errorEl = DOM.append(this.contentContainer, $('.work-item-summary-empty'));
		const message = error instanceof Error ? error.message : String(error);
		errorEl.textContent = localize('summary.error', "Failed to generate summary: {0}", message);
	}

	private async copySummary(): Promise<void> {
		if (this.currentMarkdown) {
			await this.clipboardService.writeText(this.currentMarkdown);
		}
	}

	// --- Helpers ---

	private addRangeOption(value: SummaryTimeRange, label: string): void {
		const option = document.createElement('option');
		option.value = value;
		option.textContent = label;
		this.rangeSelect.appendChild(option);
	}
}
