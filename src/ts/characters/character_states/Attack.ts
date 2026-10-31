import { CharacterStateBase, Idle, Walk } from './_stateLibrary';
import { ICharacterState } from '../../interfaces/ICharacterState';
import { Character } from '../Character';

/**
 * Short melee attack / tackle state.
 * Uses existing animation clips where possible and falls back gracefully.
 */
export class Attack extends CharacterStateBase implements ICharacterState
{
	private hitApplied: boolean = false;

	constructor(character: Character)
	{
		super(character);

		this.character.velocitySimulator.damping = 0.7;
		this.character.velocitySimulator.mass = 20;
		this.character.setArcadeVelocityTarget(0);

		// Prefer a punch-like clip if present, otherwise use a short idle / jump_idle as feedback
		const tryAnims = ['punch', 'attack', 'hit', 'jump_idle', 'idle'];
		let played = false;
		for (const name of tryAnims)
		{
			try
			{
				const len = this.character.setAnimation(name, 0.05);
				if (len > 0)
				{
					this.animationLength = len;
					played = true;
					break;
				}
			}
			catch (e) {}
		}
		if (!played)
		{
			this.playAnimation('idle', 0.05);
		}

		// Perform the actual hit logic once when entering the state
		this.character.performMeleeHit();
		this.hitApplied = true;
	}

	public update(timeStep: number): void
	{
		super.update(timeStep);

		// Brief attack window then return to idle / walk
		if (this.timer > 0.35)
		{
			if (this.anyDirection())
			{
				this.character.setState(new Walk(this.character));
			}
			else
			{
				this.character.setState(new Idle(this.character));
			}
		}
	}

	public onInputChange(): void
	{
		// Ignore further attack presses while already attacking
	}
}
