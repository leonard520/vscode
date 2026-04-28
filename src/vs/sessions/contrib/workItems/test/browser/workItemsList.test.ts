/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getWorkItemSessionSummary } from '../../browser/workItemsList.js';

suite('Sessions - WorkItemsList', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('shows session titles when a work item has multiple sessions', () => {
		assert.strictEqual(
			getWorkItemSessionSummary(['Session 1', 'Session 2']),
			'2 sessions: Session 1, Session 2'
		);
	});

	test('shows overflow summary when more than two sessions exist', () => {
		assert.strictEqual(
			getWorkItemSessionSummary(['Session 1', 'Session 2', 'Session 3']),
			'3 sessions: Session 1, Session 2 +1 more'
		);
	});

	test('keeps single-session items compact', () => {
		assert.strictEqual(getWorkItemSessionSummary(['Session 1']), 'Session 1');
		assert.strictEqual(getWorkItemSessionSummary([]), undefined);
	});
});
