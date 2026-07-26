/**
 * Manage swarm runs.
 */
import { Args, Command, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { type SwarmAction, type SwarmCommandArgs, runSwarmCommand } from "../cli/swarm-cli";
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
			description: "Path to loop.yaml (for run/plan) or session name (for resume)",
			required: false,
		}),
	};

	static examples = [
		"# Run a swarm from a loop.yaml\n  stp swarm run ./loop.yaml",
		"# Plan a swarm run\n  stp swarm plan ./loop.yaml",
		"# Resume a swarm session\n  stp swarm resume my-swarm",
	];

	async run(): Promise<void> {
		const { args } = await this.parse(Swarm);
		if (!args.action) {
			renderCommandHelp("omp", "swarm", Swarm);
			return;
		}

		if (!args.target) {
			process.stderr.write(
				args.action === "resume"
					? "Usage: stp swarm resume <session-name>\n"
					: `Usage: stp swarm ${args.action} <path-to-loop.yaml>\n`,
			);
			process.exitCode = 1;
			return;
		}

		const cmd: SwarmCommandArgs = {
			action: args.action as SwarmAction,
			target: args.target,
			flags: {},
		};

		await initTheme();
		await runSwarmCommand(cmd);
	}
}
