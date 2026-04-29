/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { SummaryMode, SummaryTimeRange } from './workItemSummaryGenerator.js';

export const WORK_ITEM_SUMMARY_EDITOR_ID = 'sessions.workItemSummaryEditor';
export const WORK_ITEM_SUMMARY_EDITOR_INPUT_ID = 'sessions.workItemSummaryEditorInput';

/**
 * Editor input for the Work Item Summary editor.
 * Carries the initial time range selection and summary mode for generating the summary.
 */
export class WorkItemSummaryEditorInput extends EditorInput {

	static readonly ID: string = WORK_ITEM_SUMMARY_EDITOR_INPUT_ID;

	readonly resource = undefined;

	constructor(
		readonly timeRange: SummaryTimeRange,
		readonly mode: SummaryMode = SummaryMode.Simple,
	) {
		super();
	}

	override get capabilities(): EditorInputCapabilities {
		return super.capabilities;
	}

	override get typeId(): string {
		return WorkItemSummaryEditorInput.ID;
	}

	override getName(): string {
		return localize('workItemSummaryEditorName', "Work Summary");
	}

	override getIcon(): ThemeIcon {
		return Codicon.report;
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(otherInput)) {
			return true;
		}
		return otherInput instanceof WorkItemSummaryEditorInput
			&& otherInput.timeRange === this.timeRange
			&& otherInput.mode === this.mode;
	}

	override async resolve(): Promise<null> {
		return null;
	}
}
