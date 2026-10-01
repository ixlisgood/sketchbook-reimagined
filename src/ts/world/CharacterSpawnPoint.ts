import { ISpawnPoint } from '../interfaces/ISpawnPoint';
import * as THREE from 'three';
import { World } from './World';
import { Character } from '../characters/Character';
import { LoadingManager } from '../core/LoadingManager';
import * as Utils from '../core/FunctionLibrary';
import { CitizenBehaviour } from '../characters/character_ai/CitizenBehaviour';
import { PathNode } from './PathNode';

export class CharacterSpawnPoint implements ISpawnPoint
{
	private object: THREE.Object3D;

	constructor(object: THREE.Object3D)
	{
		this.object = object;
	}
	
	public spawn(loadingManager: LoadingManager, world: World): void
	{
		loadingManager.loadGLTF('build/assets/boxman.glb', (model) =>
		{
			let player = new Character(model);
			
			let worldPos = new THREE.Vector3();
			this.object.getWorldPosition(worldPos);
			player.setPosition(worldPos.x, worldPos.y, worldPos.z);
			
			let forward = Utils.getForward(this.object);
			player.setOrientation(forward, true);
			
			world.add(player);
			player.takeControl();
			if (world.onlineMultiplayer !== undefined) world.onlineMultiplayer.setLocalCharacter(player);
		});
	}

	public static spawnAI(loadingManager: LoadingManager, world: World, node: PathNode): void
	{
		loadingManager.loadGLTF('build/assets/boxman.glb', (model) =>
		{
			const citizen = new Character(model);
			const position = node.object.getWorldPosition(new THREE.Vector3());
			citizen.setPosition(position.x, position.y, position.z);
			citizen.setBehaviour(new CitizenBehaviour(node));
			world.add(citizen);
		});
	}
}