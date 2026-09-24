import * as THREE from 'three';
import * as CANNON from 'cannon';

import { Vehicle } from './Vehicle';
import { VehicleSeat } from './VehicleSeat';
import { IControllable } from '../interfaces/IControllable';
import { IWorldEntity } from '../interfaces/IWorldEntity';
import { KeyBinding } from '../core/KeyBinding';
import { SpringSimulator } from '../physics/spring_simulation/SpringSimulator';
import * as Utils from '../core/FunctionLibrary';
import { EntityType } from '../enums/EntityType';
import { CollisionGroups } from '../enums/CollisionGroups';

export class Airplane extends Vehicle implements IControllable, IWorldEntity
{
	public entityType: EntityType = EntityType.Airplane;

	private steeringSimulator: SpringSimulator;
	private enginePower: number = 0;
	private lastDrag: number = 0;

	constructor(gltf: any)
	{
		super(gltf, {
			radius: 0.12,
			suspensionStiffness: 150,
			suspensionRestLength: 0.25,
			dampingRelaxation: 5,
			dampingCompression: 5,
			directionLocal: new CANNON.Vec3(0, -1, 0),
			axleLocal: new CANNON.Vec3(-1, 0, 0),
			chassisConnectionPointLocal: new CANNON.Vec3(),
		});

		this.ensureJetSetup(gltf);

		this.collision.preStep = (body: CANNON.Body) => { this.physicsPreStep(body, this); };

		this.actions = {
			'throttle': new KeyBinding('ShiftLeft'),
			'brake': new KeyBinding('Space'),
			'wheelBrake': new KeyBinding('KeyB'),
			'pitchUp': new KeyBinding('KeyS'),
			'pitchDown': new KeyBinding('KeyW'),
			'yawLeft': new KeyBinding('KeyQ'),
			'yawRight': new KeyBinding('KeyE'),
			'rollLeft': new KeyBinding('KeyA'),
			'rollRight': new KeyBinding('KeyD'),
			'exitVehicle': new KeyBinding('KeyF'),
			'seat_switch': new KeyBinding('KeyX'),
			'view': new KeyBinding('KeyV'),
		};

		this.steeringSimulator = new SpringSimulator(60, 10, 0.6);
	}

	/** Custom F-16 mesh has no sketchbook rotor/seat/collision rig — add defaults. */
	private ensureJetSetup(gltf: any): void
	{
		const junk: THREE.Object3D[] = [];
		gltf.scene.traverse((child: any) =>
		{
			if ((child.isMesh || child.isSkinnedMesh || child.isLine || child.isPoints) && !child.geometry)
			{
				junk.push(child);
			}
			if (child.isSkinnedMesh)
			{
				child.frustumCulled = false;
			}
		});
		junk.forEach((node) => { if (node.parent) node.parent.remove(node); });

		// F-16 export is X-forward / wrong roll — physics uses +Z forward
		gltf.scene.rotation.set(0, -Math.PI / 2, 0);
		gltf.scene.scale.setScalar(2.2);
		gltf.scene.position.y = 0.9;
		gltf.scene.traverse((child: any) =>
		{
			if (!child.isMesh || !child.material) return;
			child.material = new THREE.MeshPhongMaterial({
				color: 0xffffff,
				emissive: 0x777777,
				shininess: 80,
				specular: 0x555555,
				skinning: child.isSkinnedMesh === true
			});
			child.castShadow = true;
			child.receiveShadow = true;
		});

		if (this.collision.shapes.length === 0)
		{
			const phys = new CANNON.Box(new CANNON.Vec3(3.2, 0.7, 6.5));
			phys.collisionFilterMask = ~CollisionGroups.TrimeshColliders;
			this.collision.addShape(phys, new CANNON.Vec3(0, 0.9, 0));
			this.collision.mass = 40;
			this.collision.updateMassProperties();
		}

		if (this.seats.length === 0)
		{
			const scene = gltf.scene;
			const seatObj = new THREE.Object3D();
			seatObj.name = 'seat_f16';
			seatObj.position.set(0, 1.4, 2.0);
			seatObj.userData = { data: 'seat', seat_type: 'driver', entry_points: 'entry_f16' };
			const entry = new THREE.Object3D();
			entry.name = 'entry_f16';
			entry.position.set(3.2, 0.2, 2.0);
			scene.add(seatObj);
			scene.add(entry);
			this.seats.push(new VehicleSeat(this, seatObj, gltf));
		}
	}

	public noDirectionPressed(): boolean
	{
		return !this.actions.throttle.isPressed &&
			!this.actions.brake.isPressed &&
			!this.actions.yawLeft.isPressed &&
			!this.actions.yawRight.isPressed &&
			!this.actions.rollLeft.isPressed &&
			!this.actions.rollRight.isPressed;
	}

	public update(timeStep: number): void
	{
		super.update(timeStep);

		if (this.controllingCharacter !== undefined)
		{
			if (this.enginePower < 1) this.enginePower += timeStep * 1.2;
			if (this.enginePower > 1) this.enginePower = 1;
		}
		else
		{
			if (this.enginePower > 0) this.enginePower -= timeStep * 0.2;
			if (this.enginePower < 0) this.enginePower = 0;
		}

		if (this.rayCastVehicle.numWheelsOnGround > 0)
		{
			if ((this.actions.yawLeft.isPressed || this.actions.rollLeft.isPressed)
				&& !this.actions.yawRight.isPressed && !this.actions.rollRight.isPressed)
			{
				this.steeringSimulator.target = 0.8;
			}
			else if ((this.actions.yawRight.isPressed || this.actions.rollRight.isPressed)
				&& !this.actions.yawLeft.isPressed && !this.actions.rollLeft.isPressed)
			{
				this.steeringSimulator.target = -0.8;
			}
			else
			{
				this.steeringSimulator.target = 0;
			}
		}
		else
		{
			this.steeringSimulator.target = 0;
		}
		this.steeringSimulator.simulate(timeStep);
		this.setSteeringValue(this.steeringSimulator.position);
	}

	public physicsPreStep(body: CANNON.Body, plane: Airplane): void
	{
		const quat = Utils.threeQuat(body.quaternion);
		const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
		const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
		const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(quat);

		const velocity = new CANNON.Vec3().copy(this.collision.velocity);
		const velLength1 = body.velocity.length();
		const currentSpeed = velocity.dot(Utils.cannonVector(forward));

		let flightModeInfluence = THREE.MathUtils.clamp(currentSpeed / 10, 0, 1);
		let lowerMassInfluence = THREE.MathUtils.clamp(currentSpeed / 10, 0, 1);
		this.collision.mass = 40 * (1 - (lowerMassInfluence * 0.6));

		let lookVelocity = body.velocity.clone();
		if (lookVelocity.length() > 0.001) lookVelocity.normalize();
		let rotStabVelocity = new THREE.Quaternion().setFromUnitVectors(forward, Utils.threeVector(lookVelocity));
		rotStabVelocity.x *= 0.3;
		rotStabVelocity.y *= 0.3;
		rotStabVelocity.z *= 0.3;
		rotStabVelocity.w *= 0.3;
		const rotStabEuler = new THREE.Euler().setFromQuaternion(rotStabVelocity);

		let rotStabInfluence = THREE.MathUtils.clamp(velLength1 - 1, 0, 0.1);
		rotStabInfluence *= (this.rayCastVehicle.numWheelsOnGround > 0 && currentSpeed < 0 ? 0 : 1);
		const loopFix = (this.actions.throttle.isPressed && currentSpeed > 0 ? 0 : 1);

		body.angularVelocity.x += rotStabEuler.x * rotStabInfluence * loopFix;
		body.angularVelocity.y += rotStabEuler.y * rotStabInfluence;
		body.angularVelocity.z += rotStabEuler.z * rotStabInfluence * loopFix;

		const turn = 0.055 * flightModeInfluence * this.enginePower;
		if (plane.actions.pitchUp.isPressed)
		{
			body.angularVelocity.x -= right.x * turn;
			body.angularVelocity.y -= right.y * turn;
			body.angularVelocity.z -= right.z * turn;
		}
		if (plane.actions.pitchDown.isPressed)
		{
			body.angularVelocity.x += right.x * turn;
			body.angularVelocity.y += right.y * turn;
			body.angularVelocity.z += right.z * turn;
		}
		if (plane.actions.yawLeft.isPressed)
		{
			body.angularVelocity.x += up.x * turn * 0.5;
			body.angularVelocity.y += up.y * turn * 0.5;
			body.angularVelocity.z += up.z * turn * 0.5;
		}
		if (plane.actions.yawRight.isPressed)
		{
			body.angularVelocity.x -= up.x * turn * 0.5;
			body.angularVelocity.y -= up.y * turn * 0.5;
			body.angularVelocity.z -= up.z * turn * 0.5;
		}
		if (plane.actions.rollLeft.isPressed)
		{
			body.angularVelocity.x -= forward.x * turn * 1.2;
			body.angularVelocity.y -= forward.y * turn * 1.2;
			body.angularVelocity.z -= forward.z * turn * 1.2;
		}
		if (plane.actions.rollRight.isPressed)
		{
			body.angularVelocity.x += forward.x * turn * 1.2;
			body.angularVelocity.y += forward.y * turn * 1.2;
			body.angularVelocity.z += forward.z * turn * 1.2;
		}

		let speedModifier = 0.04;
		if (plane.actions.throttle.isPressed && !plane.actions.brake.isPressed)
		{
			speedModifier = 0.38;
		}
		else if (!plane.actions.throttle.isPressed && plane.actions.brake.isPressed)
		{
			speedModifier = -0.1;
		}
		else if (this.rayCastVehicle.numWheelsOnGround > 0)
		{
			speedModifier = 0;
		}
		const boostMul = this.userData.speedBoost === true ? 1.8 : 1.25;

		body.velocity.x += (velLength1 * this.lastDrag + speedModifier) * forward.x * this.enginePower * boostMul;
		body.velocity.y += (velLength1 * this.lastDrag + speedModifier) * forward.y * this.enginePower * boostMul;
		body.velocity.z += (velLength1 * this.lastDrag + speedModifier) * forward.z * this.enginePower * boostMul;

		const velLength2 = body.velocity.length();
		const drag = Math.pow(velLength2, 1) * 0.0007 * this.enginePower;
		body.velocity.x -= body.velocity.x * drag;
		body.velocity.y -= body.velocity.y * drag;
		body.velocity.z -= body.velocity.z * drag;
		this.lastDrag = drag;

		let lift = Math.pow(velLength2, 1) * 0.006 * this.enginePower;
		lift = THREE.MathUtils.clamp(lift, 0, 0.08);
		body.velocity.x += up.x * lift;
		body.velocity.y += up.y * lift;
		body.velocity.z += up.z * lift;

		body.angularVelocity.x = THREE.MathUtils.lerp(body.angularVelocity.x, body.angularVelocity.x * 0.98, flightModeInfluence);
		body.angularVelocity.y = THREE.MathUtils.lerp(body.angularVelocity.y, body.angularVelocity.y * 0.98, flightModeInfluence);
		body.angularVelocity.z = THREE.MathUtils.lerp(body.angularVelocity.z, body.angularVelocity.z * 0.98, flightModeInfluence);
	}

	public onInputChange(): void
	{
		super.onInputChange();

		const brakeForce = 100;
		if (this.actions.exitVehicle.justPressed && this.controllingCharacter !== undefined)
		{
			this.forcePassengersOut();
			(this as any).kickAt = Date.now();
			this.forceCharacterOut();
		}
		if (this.actions.wheelBrake.justPressed) this.setBrake(brakeForce);
		if (this.actions.wheelBrake.justReleased) this.setBrake(0);
		if (this.actions.view.justPressed) this.toggleFirstPersonView();
	}

	public inputReceiverInit(): void
	{
		super.inputReceiverInit();
		this.world.updateControls([
			{ keys: ['Shift'], desc: 'Afterburner' },
			{ keys: ['Space'], desc: 'Decelerate' },
			{ keys: ['W', 'S'], desc: 'Pitch' },
			{ keys: ['A', 'D'], desc: 'Roll' },
			{ keys: ['Q', 'E'], desc: 'Yaw' },
			{ keys: ['B'], desc: 'Brake' },
			{ keys: ['V'], desc: 'View' },
			{ keys: ['F'], desc: 'Exit' },
		]);
	}
}
