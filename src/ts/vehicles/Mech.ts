import * as THREE from 'three';
import * as CANNON from 'cannon';
import { Vehicle } from './Vehicle';
import { IControllable } from '../interfaces/IControllable';
import { KeyBinding } from '../core/KeyBinding';
import { EntityType } from '../enums/EntityType';
import * as PhysicsUtils from '../core/FunctionLibrary';

export class Mech extends Vehicle implements IControllable
{
	public entityType: EntityType = EntityType.Mech;
	private grabbedBody: CANNON.Body | undefined = undefined;

	constructor(gltf: any)
	{
		super(Mech.scaleModel(gltf));
		this.actions = {
			'throttle': new KeyBinding('KeyW'),
			'reverse': new KeyBinding('KeyS'),
			'left': new KeyBinding('KeyA'),
			'right': new KeyBinding('KeyD'),
			'exitVehicle': new KeyBinding('KeyF'),
			'seat_switch': new KeyBinding('KeyX'),
			'grab': new KeyBinding('KeyE'),
			'throw': new KeyBinding('KeyQ'),
			'view': new KeyBinding('KeyV'),
		};
		if (this.seats[0] !== undefined) this.seats[0].seatPointObject.position.y = 0.5;
		this.userData.vehicleType = 'mech';
	}

	private static scaleModel(gltf: any): any
	{
		gltf.scene.scale.multiplyScalar(2.2);
		return gltf;
	}

	public noDirectionPressed(): boolean
	{
		return !this.actions.throttle.isPressed && !this.actions.reverse.isPressed && !this.actions.left.isPressed && !this.actions.right.isPressed;
	}

	public update(timeStep: number): void
	{
		super.update(timeStep);
		const forward = new CANNON.Vec3(0, 0, 1);
		this.collision.quaternion.vmult(forward, forward);
		const drive = (this.actions.throttle.isPressed ? 1 : 0) - (this.actions.reverse.isPressed ? 1 : 0);
		const speed = 16;
		this.collision.velocity.x = forward.x * drive * speed;
		this.collision.velocity.z = forward.z * drive * speed;
		this.collision.angularVelocity.y = (this.actions.left.isPressed ? 1 : 0) - (this.actions.right.isPressed ? 1 : 0);
		if (this.grabbedBody !== undefined && this.controllingCharacter !== undefined)
		{
			const direction = this.world.camera.getWorldDirection(new THREE.Vector3());
			const target = this.world.camera.position.clone().add(direction.multiplyScalar(3));
			const velocity = target.sub(PhysicsUtils.threeVector(this.grabbedBody.position)).multiplyScalar(7);
			this.grabbedBody.velocity.set(velocity.x, velocity.y, velocity.z);
			this.grabbedBody.wakeUp();
		}
	}

	public onInputChange(): void
	{
		super.onInputChange();
		if (this.actions.exitVehicle.justPressed && this.controllingCharacter !== undefined) this.forceCharacterOut();
		if (this.actions.grab.justPressed) this.toggleGrab();
		if (this.actions.throw.justPressed && this.grabbedBody !== undefined) this.throwGrabbed();
	}

	private toggleGrab(): void
	{
		if (this.grabbedBody !== undefined)
		{
			this.grabbedBody = undefined;
			return;
		}
		if (this.world === undefined) return;
		const direction = this.world.camera.getWorldDirection(new THREE.Vector3());
		const start = this.world.camera.position;
		const end = start.clone().add(direction.multiplyScalar(14));
		const hit = new CANNON.RaycastResult();
		if (this.world.physicsWorld.raycastClosest(PhysicsUtils.cannonVector(start), PhysicsUtils.cannonVector(end), { skipBackfaces: true }, hit) && hit.body.mass > 0 && hit.body !== this.collision)
		{
			this.grabbedBody = hit.body;
			this.grabbedBody.wakeUp();
		}
	}

	private throwGrabbed(): void
	{
		const body = this.grabbedBody;
		if (body === undefined) return;
		const direction = this.world.camera.getWorldDirection(new THREE.Vector3());
		body.velocity.set(direction.x * 24, direction.y * 24 + 4, direction.z * 24);
		body.wakeUp();
		this.grabbedBody = undefined;
	}
}