/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import * as nls from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IExtensionManagementService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as WorkbenchExtensions, IWorkbenchContribution, IWorkbenchContributionsRegistry } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { EnablementState, IWorkbenchExtensionEnablementService } from '../../../services/extensionManagement/common/extensionManagement.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';

/** Activation time thresholds in milliseconds */
const SLOW_THRESHOLD_MS = 1000;
const WARN_THRESHOLD_MS = 500;

/** How often to re-evaluate extension health in milliseconds */
const POLL_INTERVAL_MS = 10_000;

const SHOW_HEALTH_COMMAND = 'workbench.action.pluginHealth.showDetails';

type ExtensionHealthStatus = 'healthy' | 'warn' | 'slow' | 'error';

interface ExtensionHealthInfo {
	readonly id: string;
	readonly displayName: string;
	readonly activateMs: number;
	readonly runtimeErrors: number;
	readonly status: ExtensionHealthStatus;
}

export class PluginHealthStatusBarContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.pluginHealth';

	private entryAccessor: IStatusbarEntryAccessor | undefined;
	private hostUnresponsive = false;
	private pollHandle: ReturnType<typeof setInterval> | undefined;

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ICommandService private readonly commandService: ICommandService,
		@IExtensionManagementService private readonly extensionManagementService: IExtensionManagementService,
		@IWorkbenchExtensionEnablementService private readonly extensionEnablementService: IWorkbenchExtensionEnablementService,
	) {
		super();

		this._register(this.extensionService.onDidChangeExtensionsStatus(() => this.update()));
		this._register(this.extensionService.onDidChangeResponsiveChange(e => {
			this.hostUnresponsive = !e.isResponsive;
			this.update();
		}));

		CommandsRegistry.registerCommand(SHOW_HEALTH_COMMAND, () => this.showHealthDetails());

		this.pollHandle = setInterval(() => this.update(), POLL_INTERVAL_MS);
		this._register({ dispose: () => clearInterval(this.pollHandle) });

		this.extensionService.whenInstalledExtensionsRegistered().then(() => this.update());
	}

	private getHealthInfos(): ExtensionHealthInfo[] {
		const statusMap = this.extensionService.getExtensionsStatus();
		const infos: ExtensionHealthInfo[] = [];

		for (const ext of this.extensionService.extensions) {
			const id = ext.identifier.value;
			const s = statusMap[id];
			if (!s?.activationTimes) {
				continue;
			}

			const activateMs = s.activationTimes.activateResolvedTime;
			const runtimeErrors = s.runtimeErrors.length;

			let status: ExtensionHealthStatus = 'healthy';
			if (runtimeErrors > 0) {
				status = 'error';
			} else if (activateMs >= SLOW_THRESHOLD_MS) {
				status = 'slow';
			} else if (activateMs >= WARN_THRESHOLD_MS) {
				status = 'warn';
			}

			infos.push({
				id,
				displayName: ext.displayName ?? ext.name,
				activateMs,
				runtimeErrors,
				status,
			});
		}

		return infos;
	}

	private update(): void {
		const entry = this.buildEntry();
		if (!this.entryAccessor) {
			this.entryAccessor = this.statusbarService.addEntry(entry, 'status.pluginHealth', StatusbarAlignment.RIGHT, 90);
		} else {
			this.entryAccessor.update(entry);
		}
	}

	private buildEntry(): IStatusbarEntry {
		if (this.hostUnresponsive) {
			return {
				name: nls.localize('pluginHealth.name', "Extension Health"),
				text: `$(error) ${nls.localize('pluginHealth.hostDown', "Host down")}`,
				ariaLabel: nls.localize('pluginHealth.hostDownAria', "Extension host is unresponsive"),
				tooltip: nls.localize('pluginHealth.hostDownTooltip', "Extension host is not responding. Click for details."),
				command: SHOW_HEALTH_COMMAND,
				kind: 'error',
			};
		}

		const infos = this.getHealthInfos();
		const errorCount = infos.filter(i => i.status === 'error').length;
		const slowCount = infos.filter(i => i.status === 'slow' || i.status === 'warn').length;

		if (errorCount > 0) {
			return {
				name: nls.localize('pluginHealth.name', "Extension Health"),
				text: `$(error) ${nls.localize('pluginHealth.errors', "{0} error(s)", errorCount)}`,
				ariaLabel: nls.localize('pluginHealth.errorsAria', "{0} extensions have errors", errorCount),
				tooltip: nls.localize('pluginHealth.errorTooltip', "{0} extension(s) have runtime errors. Click to inspect.", errorCount),
				command: SHOW_HEALTH_COMMAND,
				kind: 'error',
			};
		}

		if (slowCount > 0) {
			return {
				name: nls.localize('pluginHealth.name', "Extension Health"),
				text: `$(warning) ${nls.localize('pluginHealth.slow', "{0} slow", slowCount)}`,
				ariaLabel: nls.localize('pluginHealth.slowAria', "{0} extensions are slow to activate", slowCount),
				tooltip: nls.localize('pluginHealth.slowTooltip', "{0} extension(s) have slow activation times. Click to inspect.", slowCount),
				command: SHOW_HEALTH_COMMAND,
				kind: 'warning',
			};
		}

		return {
			name: nls.localize('pluginHealth.name', "Extension Health"),
			text: `$(pulse) ${nls.localize('pluginHealth.healthy', "Healthy")}`,
			ariaLabel: nls.localize('pluginHealth.healthyAria', "All extensions are healthy"),
			tooltip: nls.localize('pluginHealth.healthyTooltip', "All extensions are healthy. Click to inspect."),
			command: SHOW_HEALTH_COMMAND,
			kind: 'standard',
		};
	}

	private async showHealthDetails(): Promise<void> {
		// Sort: errors first, then by slowest activation time
		const infos = this.getHealthInfos().sort((a, b) => {
			const rank = (s: ExtensionHealthStatus) => s === 'error' ? 0 : s === 'slow' ? 1 : s === 'warn' ? 2 : 3;
			const rankDiff = rank(a.status) - rank(b.status);
			return rankDiff !== 0 ? rankDiff : b.activateMs - a.activateMs;
		});

		type PickItem = IQuickPickItem & { extId?: string };

		const statusIcon = (s: ExtensionHealthStatus) =>
			s === 'error' ? '$(error)' : s === 'slow' ? '$(warning)' : s === 'warn' ? '$(info)' : '$(check)';

		const extensionItems: PickItem[] = infos.map(info => ({
			label: `${statusIcon(info.status)} ${info.displayName}`,
			description: info.activateMs > 0
				? nls.localize('pluginHealth.activateTime', "activated in {0}ms", info.activateMs)
				: nls.localize('pluginHealth.notActivated', "not timed"),
			detail: info.runtimeErrors > 0
				? nls.localize('pluginHealth.runtimeErrors', "{0} runtime error(s) — consider hibernating this extension", info.runtimeErrors)
				: info.status === 'slow' || info.status === 'warn'
					? nls.localize('pluginHealth.slowDetail', "Slow activation — click to hibernate (disable for this workspace)")
					: undefined,
			extId: info.id,
		}));

		const hostWarning: PickItem[] = this.hostUnresponsive
			? [{ label: `$(error) ${nls.localize('pluginHealth.hostUnresponsive', "Extension host is unresponsive!")}`, extId: '__host__' }]
			: [];

		const separator: IQuickPickSeparator = { type: 'separator', label: nls.localize('pluginHealth.actions', "Actions") };
		const openRuntimeExtensions: PickItem = {
			label: `$(tools) ${nls.localize('pluginHealth.openRuntime', "Open Runtime Extensions Editor")}`,
			extId: '__runtime__',
		};

		const allItems: (PickItem | IQuickPickSeparator)[] = [
			...hostWarning,
			...extensionItems,
			separator,
			openRuntimeExtensions,
		];

		const pick = await this.quickInputService.pick(allItems as PickItem[], {
			placeHolder: nls.localize('pluginHealth.placeholder', "Extension Health — select a slow or erroring extension to hibernate it"),
			matchOnDescription: true,
			matchOnDetail: true,
		});

		if (!pick?.extId) {
			return;
		}

		if (pick.extId === '__runtime__') {
			await this.commandService.executeCommand('workbench.action.showRuntimeExtensions');
			return;
		}

		if (pick.extId !== '__host__') {
			await this.hibernateExtension(pick.extId);
		}
	}

	/**
	 * Disables the given extension for the current workspace (hibernate).
	 * The user can re-enable it from the Extensions view.
	 */
	private async hibernateExtension(extensionId: string): Promise<void> {
		const installed = await this.extensionManagementService.getInstalled();
		const ext = installed.find(e => e.identifier.id.toLowerCase() === extensionId.toLowerCase());
		if (!ext || !this.extensionEnablementService.canChangeEnablement(ext)) {
			return;
		}
		await this.extensionEnablementService.setEnablement([ext], EnablementState.DisabledWorkspace);
	}

	override dispose(): void {
		this.entryAccessor?.dispose();
		super.dispose();
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(PluginHealthStatusBarContribution, LifecyclePhase.Eventually);
