/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { FilterViewPane, IViewPaneOptions } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { WorkItemsList } from './workItemsList.js';
import { IWorkItemService } from '../../../services/workItems/common/workItemService.js';
import { Menus } from '../../../browser/menus.js';

const $ = DOM.$;
export const WorkItemsViewId = 'sessions.workbench.view.workItemsView';

export class WorkItemsView extends FilterViewPane {

	private _workItemsList: WorkItemsList | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IWorkItemService private readonly _workItemService: IWorkItemService,
	) {
		super({
			...options,
			titleMenuId: Menus.WorkItemsViewTitle,
			filterOptions: {
				ariaLabel: localize('workItems.filter.ariaLabel', "Filter Work Items"),
				placeholder: localize('workItems.filter.placeholder', "Filter (e.g. title, label, status)"),
				text: '',
				history: [],
			}
		}, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		const listContainer = DOM.append(container, $('.work-items-list-container'));
		this._workItemsList = this._register(this.instantiationService.createInstance(WorkItemsList, listContainer));
		this._workItemsList.create();

		this._register(this.filterWidget.onDidChangeFilterText(text => {
			this._workItemsList?.setFilter(text);
			this._updateFilterBadge();
		}));

		this._register(this._workItemService.onDidChangeWorkItems(() => {
			this._updateFilterBadge();
		}));
	}

	private _updateFilterBadge(): void {
		if (!this._workItemsList) {
			return;
		}
		const { total, filtered } = this._workItemsList.getFilterStats();
		const filterText = this.filterWidget.getFilterText();
		if (filterText && total !== filtered) {
			this.filterWidget.updateBadge(localize('workItems.filter.badge', "{0} of {1}", filtered, total));
		} else {
			this.filterWidget.updateBadge(undefined);
		}
	}

	override shouldShowFilterInHeader(): boolean {
		// Always show the filter in the body so it remains visible without
		// hovering.  Pane-header actions are hidden by default in the sidebar
		// and only appear on hover, which would make the filter "disappear."
		return false;
	}

	protected override layoutBodyContent(height: number, width: number): void {
		this._workItemsList?.layout(height, width);
	}

	protected override focusBodyContent(): void {
		this._workItemsList?.focus();
	}
}
