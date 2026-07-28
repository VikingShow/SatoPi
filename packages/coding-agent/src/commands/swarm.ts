/**
 * Manage swarm runs.
 */
import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { runSwarmCommand, type SwarmAction, type SwarmCommandArgs } from "../cli/swarm-cli";
import { initTheme } from "../modes/theme/theme";

const ACTIONS: SwarmAction[] = ["run", "plan", "resume"];

export default class Swarm extends Command {
	static description = "Manage swarm runs";

	static args = {
		action: Args.string({
			description: "Swarm action: run, plan, or resume",
			required: false,
			options: ACTIONS,
		}),
		target: Args.string({
			description: "Path to swarm.yaml (for run/plan) or session name (for resume)",
			required: false,
		}),
	};

	static flags = {
		engine: Flags.string({
			description: "Engine to use: graph (default) or legacy",
			options: ["legacy", "graph"],
			default: "graph",
		}),
	};

	static examples = [
		"# Run a swarm from a swarm.yaml\n  stp swarm run ./swarm.yaml",
		"# Run a swarm using the graph engine\n  stp swarm run ./swarm.yaml --engine=graph",
		"# Plan a swarm run\n  stp swarm plan ./swarm.yaml",
		"# Resume a swarm session\n  stp swarm resume my-swarm",
	];
	async run(): Promise<void> {
		const { args, flags } = await this.parse(Swarm);
		if (!args.action) {
			renderCommandHelp(APP_NAME, "swarm", Swarm);
			return;
		}

		if (!args.target) {
			process.stderr.write(
				args.action === "resume"
					? "Usage: stp swarm resume <session-name>\n"
					: `Usage: stp swarm ${args.action} <path-to-swarm.yaml>\n`,
			);
			process.exitCode = 1;
			return;
		}

		const cmd: SwarmCommandArgs = {
			action: args.action as SwarmAction,
			target: args.target,
			flags: {},
			engine: flags.engine as "graph" | "legacy",
		};

		await initTheme();
		await runSwarmCommand(cmd);
	}
}
