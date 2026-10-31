import { CharacterStateBase } from './_stateLibrary';
import { ICharacterState } from '../../interfaces/ICharacterState';
import { Character } from '../Character';

/**
 * Death state – character is disabled until revived.
 */
export class Death extends CharacterStateBase implements ICharacterState
{
	constructor(character: Character)
	{
		super(character);

		this.character.velocitySimulator.damping = 1;
		this.character.velocitySimulator.mass = 50;
		this.character.setArcadeVelocityTarget(0);
		this.character.characterCapsule.body.velocity.set(0, 0, 0);

		// Try death / falling / idle
		const tryAnims = ['death', 'falling', 'drop_idle', 'idle'];
		for (const name of tryAnims)
		{
			try
			{
				const len = this.character.setAnimation(name, 0.2);
				if (len > 0)
				{
					this.animationLength = len;
					break;
				}
			}
			catch (e) {}
		}

		// Visual: tip over
		if (this.character.tiltContainer)
		{
			this.character.tiltContainer.rotation.z = Math.PI / 2;
		}
	}

	public update(timeStep: number): void
	{
		super.update(timeStep);
		// Stay dead – no transitions out except via revive()
	}

	public onInputChange(): void
	{
		// Completely ignore input
	}
}
