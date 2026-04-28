/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IViewDescriptor, IViewsRegistry, Extensions as ViewContainerExtensions, WindowEnablement, ViewContainer, IViewContainersRegistry, ViewContainerLocation } from '../../../../workbench/common/views.js';
import { localize, localize2 } from '../../../../nls.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { WorkItemsView, WorkItemsViewId } from './workItemsView.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { IEditorPaneRegistry, EditorPaneDescriptor } from '../../../../workbench/browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkItemEditorInput, WORK_ITEM_EDITOR_INPUT_ID } from './workItemEditorInput.js';
import { WorkItemDetailEditorPane } from './workItemDetailEditorPane.js';
import './workItemsActions.js';

const workItemsViewIcon = registerIcon('work-items-icon', Codicon.checklist, localize('workItemsViewIcon', 'Icon for Work Items View'));
const WORK_ITEMS_VIEW_TITLE = localize2('workItems.view.label', "Work Items");
const WorkItemsContainerId = 'agentic.workbench.view.workItemsContainer';

const workItemsViewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer({
	id: WorkItemsContainerId,
	title: WORK_ITEMS_VIEW_TITLE,
	icon: workItemsViewIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [WorkItemsContainerId, { mergeViewWithContainerWhenSingleView: false }]),
	storageId: WorkItemsContainerId,
	hideIfEmpty: false,
	order: 5, // Before sessions (order 6)
	openCommandActionDescriptor: {
		id: WorkItemsContainerId,
		mnemonicTitle: localize({ key: 'miWorkItems', comment: ['&& denotes a mnemonic'] }, "&&Work Items"),
		keybindings: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyW },
		order: 0
	},
	windowEnablement: WindowEnablement.Sessions
}, ViewContainerLocation.Sidebar, { isDefault: true });

const workItemsViewDescriptor: IViewDescriptor = {
	id: WorkItemsViewId,
	containerIcon: workItemsViewIcon,
	containerTitle: WORK_ITEMS_VIEW_TITLE.value,
	singleViewPaneContainerTitle: WORK_ITEMS_VIEW_TITLE.value,
	name: WORK_ITEMS_VIEW_TITLE,
	canToggleVisibility: true,
	canMoveView: false,
	ctorDescriptor: new SyncDescriptor(WorkItemsView),
	windowEnablement: WindowEnablement.Sessions
};

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([workItemsViewDescriptor], workItemsViewContainer);

//#region Work Item Detail Editor

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		WorkItemDetailEditorPane,
		WorkItemDetailEditorPane.ID,
		localize('workItemDetailEditor', "Work Item Detail Editor")
	),
	[
		new SyncDescriptor(WorkItemEditorInput)
	]
);

class WorkItemEditorInputSerializer implements IEditorSerializer {

	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof WorkItemEditorInput;
	}

	serialize(input: WorkItemEditorInput): string {
		return JSON.stringify({ workItemId: input.workItemId });
	}

	deserialize(instantiationService: IInstantiationService, serialized: string): WorkItemEditorInput | undefined {
		try {
			const data = JSON.parse(serialized);
			if (data?.workItemId) {
				return new WorkItemEditorInput(data.workItemId);
			}
		} catch {
			// ignore
		}
		return undefined;
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	WORK_ITEM_EDITOR_INPUT_ID,
	WorkItemEditorInputSerializer
);

//#endregion
