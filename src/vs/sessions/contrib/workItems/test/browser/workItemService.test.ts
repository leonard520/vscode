/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService, IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ISession, SessionStatus } from '../../../../services/sessions/common/session.js';
import { ISessionReplaceEvent, ISessionsChangeEvent, ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { WorkItemService } from '../../../../services/workItems/browser/workItemService.js';

function createSession(id: string): ISession {
	const resource = URI.parse(`vscode-agent-session:/${id}`);
	const chat = {
		resource,
		createdAt: new Date(),
		title: observableValue(`chat.title.${id}`, id),
		updatedAt: observableValue(`chat.updatedAt.${id}`, new Date()),
		status: observableValue(`chat.status.${id}`, SessionStatus.Untitled),
		changes: observableValue(`chat.changes.${id}`, []),
		modelId: observableValue(`chat.modelId.${id}`, undefined),
		mode: observableValue(`chat.mode.${id}`, undefined),
		isArchived: observableValue(`chat.isArchived.${id}`, false),
		isRead: observableValue(`chat.isRead.${id}`, true),
		lastTurnEnd: observableValue(`chat.lastTurnEnd.${id}`, undefined),
		description: observableValue(`chat.description.${id}`, undefined),
	};

	return {
		sessionId: id,
		resource,
		providerId: 'test-provider',
		sessionType: 'background',
		icon: Codicon.copilot,
		createdAt: chat.createdAt,
		workspace: observableValue(`session.workspace.${id}`, undefined),
		title: chat.title,
		updatedAt: chat.updatedAt,
		status: chat.status,
		changes: chat.changes,
		modelId: chat.modelId,
		mode: chat.mode,
		loading: observableValue(`session.loading.${id}`, false),
		isArchived: chat.isArchived,
		isRead: chat.isRead,
		lastTurnEnd: chat.lastTurnEnd,
		description: chat.description,
		gitHubInfo: observableValue(`session.githubInfo.${id}`, undefined),
		chats: observableValue(`session.chats.${id}`, [chat]),
		mainChat: chat,
		capabilities: { supportsMultipleChats: false },
	};
}

suite('WorkItemService', () => {
	const disposables = new DisposableStore();

	teardown(() => {
		disposables.clear();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	test('preserves all work item sessions when temporary sessions are replaced', () => {
		const instantiationService = disposables.add(new TestInstantiationService());
		const sessionsChanged = disposables.add(new Emitter<ISessionsChangeEvent>());
		const sessionReplaced = disposables.add(new Emitter<ISessionReplaceEvent>());
		const sessions: ISession[] = [];

		instantiationService.stub(IStorageService, disposables.add(new InMemoryStorageService()));
		instantiationService.stub(IContextKeyService, new MockContextKeyService());
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override readonly onDidChangeSessions = sessionsChanged.event;
			override readonly onDidReplaceSession = sessionReplaced.event;
			override readonly activeSession = observableValue('activeSession', undefined);
			override readonly activeProviderId = observableValue('activeProviderId', 'test-provider');

			override getSessions(): ISession[] {
				return [...sessions];
			}

			override async openSession(): Promise<void> { }
			override setActiveProvider(): void { }
		}());

		const service = disposables.add(instantiationService.createInstance(WorkItemService));
		const workItem = service.createWorkItem({ title: 'Investigate sessions' });

		const firstTemp = createSession('temp-1');
		sessions.push(firstTemp);
		service.addSession(workItem.id, firstTemp.sessionId);

		const firstCommitted = createSession('committed-1');
		const firstIndex = sessions.findIndex(session => session.sessionId === firstTemp.sessionId);
		assert.notStrictEqual(firstIndex, -1);
		sessions.splice(firstIndex, 1, firstCommitted);
		sessionReplaced.fire({ from: firstTemp, to: firstCommitted });

		const secondTemp = createSession('temp-2');
		sessions.push(secondTemp);
		service.addSession(workItem.id, secondTemp.sessionId);

		const secondCommitted = createSession('committed-2');
		const secondIndex = sessions.findIndex(session => session.sessionId === secondTemp.sessionId);
		assert.notStrictEqual(secondIndex, -1);
		sessions.splice(secondIndex, 1, secondCommitted);
		sessionReplaced.fire({ from: secondTemp, to: secondCommitted });

		const resolvedWorkItem = service.getWorkItem(workItem.id);
		assert.ok(resolvedWorkItem);
		assert.deepStrictEqual(
			resolvedWorkItem.sessions.get().map(session => session.sessionId),
			['committed-1', 'committed-2']
		);
	});
});
