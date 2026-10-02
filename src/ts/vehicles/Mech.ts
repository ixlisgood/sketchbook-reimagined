import * as THREE from 'three';
import * as CANNON from 'cannon';

import { Car } from './Car';
import { EntityType } from '../enums/EntityType';
import { KeyBinding } from '../core/KeyBinding';
import * as Utils from '../core/FunctionLibrary';
import { IControllable } from '../interfaces/IControllable';

export class Mech extends Car implements IControllable
{
	public entityType: EntityType = EntityType.Mech;

	private heldBody: CANNON.Body | undefined;
	private pickupRange: number = 6;

	constructor(gltf: any)
	{
		super(gltf);
		this.modelContainer.scale.set(1.7, 1.7, 1.7);
		this.userData.speedBoost = true;
		this.actions['pickup'] = new KeyBinding('KeyE');
		this.collision.mass = 120;
		this.collision.updateMassProperties();
	}

	public update(timeStep: number): void
	{
		super.update(timeStep);

		if (this.heldBody !== undefined && this.world !== undefined)
		{
			const target = this.position.clone().add(new THREE.Vector3(0, 1.8, 2.4).applyQuaternion(this.quaternion));
			const velocity = target.sub(Utils.threeVector(this.heldBody.position)).multiplyScalar(9);
			this.heldBody.velocity.set(velocity.x, velocity.y, velocity.z);
			this.heldBody.wakeUp();
		}
	}

	public onInputChange(): void
	{
		super.onInputChange();

		if (this.actions.pickup.justPressed)
		{
			if (this.heldBody !== undefined)
			{
				this.heldBody = undefined;
			}
			else
			{
				this.tryPickup();
			}
		}
	}

	public inputReceiverInit(): void
	{
		super.inputReceiverInit();
		this.world.updateControls([
			{
				keys: ['E'],
				desc: 'Grab object'
			}
		]);
	}

	private tryPickup(): void
	{
		if (this.world === undefined) return;
		const origin = this.position.clone().add(new THREE.Vector3(0, 1.2, 0));
		const direction = new THREE.Vector3(0, 0, 1).applyQuaternion(this.quaternion);
		const end = origin.clone().add(direction.clone().multiplyScalar(this.pickupRange));
		const hit = new CANNON.RaycastResult();
		const options = { skipBackfaces: true, collisionFilterMask: ~2 };

		if (this.world.physicsWorld.raycastClosest(Utils.cannonVector(origin), Utils.cannonVector(end), options, hit))
		{
			const body = hit.body;
			if (body !== undefined && body !== this.collision && body.mass > 0)
			{
				this.heldBody = body;
			}
		}
	}
}
