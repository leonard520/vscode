/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';

export const WORK_ITEM_EDITOR_ID = 'sessions.workItemEditor';
export const WORK_ITEM_EDITOR_INPUT_ID = 'sessions.workItemEditorInput';

/**
 * Editor input for the Work Item Detail Editor.
 * Each work item gets a distinct input keyed by work item ID.
 */
export class WorkItemEditorInput extends EditorInput {

	static readonly ID: string = WORK_ITEM_EDITOR_INPUT_ID;

	readonly resource = undefined;

	constructor(readonly workItemId: string) {
		super();
	}

	override get capabilities(): EditorInputCapabilities {
		return super.capabilities;
	}

	override get typeId(): string {
		return WorkItemEditorInput.ID;
	}

	override getName(): string {
		return localize('workItemEditorName', "Work Item Detail");
	}

	override getIcon(): ThemeIcon {
		return Codicon.checklist;
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(otherInput)) {
			return true;
		}
		return otherInput instanceof WorkItemEditorInput && otherInput.workItemId === this.workItemId;
	}

	override async resolve(): Promise<null> {
		return null;
	}
}
