import * as THREE from 'three';
import * as CANNON from 'cannon';
import * as _ from 'lodash';
import * as Utils from '../core/FunctionLibrary';

import { KeyBinding } from '../core/KeyBinding';
import { VectorSpringSimulator } from '../physics/spring_simulation/VectorSpringSimulator';
import { RelativeSpringSimulator } from '../physics/spring_simulation/RelativeSpringSimulator';
import { Idle } from '../character_states/Idle';
import { EnteringVehicle } from '../character_states/vehicles/EnteringVehicle';
import { ExitingVehicle } from '../character_states/vehicles/ExitingVehicle';
import { OpenVehicleDoor as OpenVehicleDoor } from '../character_states/vehicles/OpenVehicleDoor';
import { Driving } from '../character_states/vehicles/Driving';
import { ExitingAirplane } from '../character_states/vehicles/ExitingAirplane';
import { ICharacterAI } from '../interfaces/ICharacterAI';
import { World } from '../world/World';
import { IControllable } from '../interfaces/IControllable';
import { ICharacterState } from '../interfaces/ICharacterState';
import { IWorldEntity } from '../interfaces/IWorldEntity';
import { VehicleSeat } from '../vehicles/VehicleSeat';
import { Vehicle } from '../vehicles/Vehicle';
import { CollisionGroups } from '../enums/CollisionGroups';
import { CapsuleCollider } from '../physics/colliders/CapsuleCollider';
import { VehicleEntryInstance } from '../VehicleEntryInstance';
import { SeatType } from '../enums/SeatType';
import { GroundImpactData } from '../GroundImpactData';
import { ClosestObjectFinder } from '../core/ClosestObjectFinder';
import { Object3D } from 'three';
import { EntityType } from '../enums/EntityType';
import { VehicleHit } from '../character_states/VehicleHit';
import { Attack } from '../character_states/Attack';
import { Death } from '../character_states/Death';

export class Character extends THREE.Object3D implements IWorldEntity
{
	public updateOrder: number = 1;
	public entityType: EntityType = EntityType.Character;

	public height: number = 0;
	public tiltContainer: THREE.Group;
	public modelContainer: THREE.Group;
	public materials: THREE.Material[] = [];
	public mixer: THREE.AnimationMixer;
	public animations: any[];

	// Movement
	public acceleration: THREE.Vector3 = new THREE.Vector3();
	public velocity: THREE.Vector3 = new THREE.Vector3();
	public arcadeVelocityInfluence: THREE.Vector3 = new THREE.Vector3();
	public velocityTarget: THREE.Vector3 = new THREE.Vector3();
	public arcadeVelocityIsAdditive: boolean = false;

	public defaultVelocitySimulatorDamping: number = 0.8;
	public defaultVelocitySimulatorMass: number = 50;
	public velocitySimulator: VectorSpringSimulator;
	public moveSpeed: number = 4;
	public angularVelocity: number = 0;
	public orientation: THREE.Vector3 = new THREE.Vector3(0, 0, 1);
	public orientationTarget: THREE.Vector3 = new THREE.Vector3(0, 0, 1);
	public defaultRotationSimulatorDamping: number = 0.5;
	public defaultRotationSimulatorMass: number = 10;
	public rotationSimulator: RelativeSpringSimulator;
	public viewVector: THREE.Vector3;
	public actions: { [action: string]: KeyBinding };
	public characterCapsule: CapsuleCollider;
	
	// Ray casting
	public rayResult: CANNON.RaycastResult = new CANNON.RaycastResult();
	public rayHasHit: boolean = false;
	public rayCastLength: number = 0.57;
	public raySafeOffset: number = 0.03;
	public wantsToJump: boolean = false;
	public initJumpSpeed: number = -1;
	public groundImpactData: GroundImpactData = new GroundImpactData();
	public raycastBox: THREE.Mesh;
	
	public world: World;
	public charState: ICharacterState;
	public behaviour: ICharacterAI;
	
	// Vehicles
	public controlledObject: IControllable;
	public occupyingSeat: VehicleSeat = null;
	public vehicleEntryInstance: VehicleEntryInstance = null;
	public isRemote: boolean = false;
	public isFrozen: boolean = false;
	public isFlying: boolean = false;
	public isSlowed: boolean = false;
	public isFirstPerson: boolean = false;
	private playerNameLabel: THREE.Sprite;
	private moderatorTrail: THREE.Group;
	private moderatorTrailAge: number = 0;
	private moderatorTrailPosition: THREE.Vector3 = new THREE.Vector3();
	private moderatorTrailInitialized: boolean = false;
	private moderatorSkinEnabled: boolean = false;
	
	private physicsEnabled: boolean = true;
	private vehicleHitCooldown: number = 0;

	// Combat / Health system
	public maxHealth: number = 100;
	public health: number = 100;
	public isDead: boolean = false;
	public isAiming: boolean = false;
	public lastAttackTime: number = 0;
	public attackCooldown: number = 0.55; // seconds between attacks
	public attackRange: number = 2.0;
	public attackDamage: number = 25;
	public tackleForce: number = 9;
	public currentAnimName: string = 'idle'; // for network sync
	private bloodSpatters: THREE.Mesh[] = [];
	private healthBarElement: HTMLElement = null;
	private aimCrosshair: HTMLElement = null;
	// Optional callback used by OnlineMultiplayer to broadcast damage
	public onDamageDealt: (victimId: string, amount: number) => void = null;
	public networkId: string = ''; // set by OnlineMultiplayer for local / remote matching

	constructor(gltf: any)
	{
		super();

		this.readCharacterData(gltf);
		this.setAnimations(gltf.animations);

		// The visuals group is centered for easy character tilting
		this.tiltContainer = new THREE.Group();
		this.add(this.tiltContainer);

		// Model container is used to reliably ground the character, as animation can alter the position of the model itself
		this.modelContainer = new THREE.Group();
		this.modelContainer.position.y = -0.57;
		this.tiltContainer.add(this.modelContainer);
		this.modelContainer.add(gltf.scene);

		this.mixer = new THREE.AnimationMixer(gltf.scene);

		this.velocitySimulator = new VectorSpringSimulator(60, this.defaultVelocitySimulatorMass, this.defaultVelocitySimulatorDamping);
		this.rotationSimulator = new RelativeSpringSimulator(60, this.defaultRotationSimulatorMass, this.defaultRotationSimulatorDamping);

		this.viewVector = new THREE.Vector3();

		// Actions
		this.actions = {
			'up': new KeyBinding('KeyW'),
			'down': new KeyBinding('KeyS'),
			'left': new KeyBinding('KeyA'),
			'right': new KeyBinding('KeyD'),
			'run': new KeyBinding('ShiftLeft'),
			'jump': new KeyBinding('Space'),
			'use': new KeyBinding('KeyE'),
			'enter': new KeyBinding('KeyF'),
			'enter_passenger': new KeyBinding('KeyG'),
			'seat_switch': new KeyBinding('KeyX'),
			'primary': new KeyBinding('Mouse0'),
			'secondary': new KeyBinding('Mouse1'),
			'first_person': new KeyBinding('KeyV'),
		};

		// Physics
		// Player Capsule
		this.characterCapsule = new CapsuleCollider({
			mass: 1,
			position: new CANNON.Vec3(),
			height: 0.5,
			radius: 0.25,
			segments: 8,
			friction: 0.0
		});
		// capsulePhysics.physical.collisionFilterMask = ~CollisionGroups.Trimesh;
		this.characterCapsule.body.shapes.forEach((shape) => {
			// tslint:disable-next-line: no-bitwise
			shape.collisionFilterMask = ~CollisionGroups.TrimeshColliders;
		});
		this.characterCapsule.body.allowSleep = false;

		// Move character to different collision group for raycasting
		this.characterCapsule.body.collisionFilterGroup = 2;
		(this.characterCapsule.body as any).userData = { character: this };

		// Disable character rotation
		this.characterCapsule.body.fixedRotation = true;
		this.characterCapsule.body.updateMassProperties();

		// Ray cast debug
		const boxGeo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
		const boxMat = new THREE.MeshLambertMaterial({
			color: 0xff0000
		});
		this.raycastBox = new THREE.Mesh(boxGeo, boxMat);
		this.raycastBox.visible = false;

		// Physics pre/post step callback bindings
		this.characterCapsule.body.preStep = (body: CANNON.Body) => { this.physicsPreStep(body, this); };
		this.characterCapsule.body.postStep = (body: CANNON.Body) => { this.physicsPostStep(body, this); };
		this.characterCapsule.body.addEventListener('collide', (event: any) =>
		{
			const vehicle = event.body?.userData?.vehicle as Vehicle;
			if (vehicle !== undefined) this.hitByVehicle(vehicle);
		});

		// States
		this.setState(new Idle(this));
	}

	public setAnimations(animations: []): void
	{
		this.animations = animations;
	}

	public setPlayerColor(color: string): void
	{
		this.materials.forEach((material: any) =>
		{
			if (material.color !== undefined) material.color.set(color);
		});
	}

	public setPlayerName(name: string): void
	{
		if (this.playerNameLabel === undefined)
		{
			const canvas = document.createElement('canvas');
			canvas.width = 512;
			canvas.height = 96;
			const context = canvas.getContext('2d');
			context.font = 'bold 38px Arial';
			context.textAlign = 'center';
			context.fillStyle = '#ffffff';
			context.strokeStyle = '#17212b';
			context.lineWidth = 8;
			context.strokeText(name, 256, 58);
			context.fillText(name, 256, 58);
			const texture = new THREE.CanvasTexture(canvas);
			const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
			this.playerNameLabel = new THREE.Sprite(material);
			this.playerNameLabel.scale.set(1.6, 0.3, 1);
			this.playerNameLabel.position.set(0, 1.35, 0);
			this.add(this.playerNameLabel);
		}
		const canvas = (this.playerNameLabel.material as THREE.SpriteMaterial).map.image as HTMLCanvasElement;
		const context = canvas.getContext('2d');
		context.clearRect(0, 0, canvas.width, canvas.height);
		context.font = 'bold 38px Arial';
		context.textAlign = 'center';
		context.fillStyle = '#ffffff';
		context.strokeStyle = '#17212b';
		context.lineWidth = 8;
		context.strokeText(name, 256, 58);
		context.fillText(name, 256, 58);
		(this.playerNameLabel.material as THREE.SpriteMaterial).map.needsUpdate = true;
	}

	public setModeratorSkin(enabled: boolean): void
	{
		this.moderatorSkinEnabled = enabled;
		if (enabled)
		{
			this.materials.forEach((material: any) =>
			{
				if (material.color !== undefined) material.color.set('#030507');
			});
			if (this.moderatorTrail === undefined)
			{
				this.moderatorTrail = new THREE.Group();
				this.world?.graphicsWorld.add(this.moderatorTrail);
				this.moderatorTrailPosition.copy(this.getWorldPosition(new THREE.Vector3()));
				this.moderatorTrailInitialized = true;
			}
		}
		else
		{
			this.removeModeratorTrail();
		}
	}

	private removeModeratorTrail(): void
	{
		if (this.moderatorTrail !== undefined)
		{
			this.moderatorTrail.children.slice().forEach((child: THREE.Object3D) =>
			{
				this.moderatorTrail.remove(child);
				child.traverse((node: any) =>
				{
					if (node.geometry) node.geometry.dispose();
					if (node.material)
					{
						const mats = Array.isArray(node.material) ? node.material : [node.material];
						mats.forEach((mat: any) => mat.dispose && mat.dispose());
					}
				});
			});
			if (this.world !== undefined) this.world.graphicsWorld.remove(this.moderatorTrail);
			this.moderatorTrail = undefined;
		}
		this.moderatorTrailInitialized = false;
	}

	private spawnModeratorSkinTrail(worldPosition: THREE.Vector3): void
	{
		if (this.moderatorTrail === undefined || this.modelContainer === undefined) return;

		const clone = this.modelContainer.clone(true);
		clone.position.copy(worldPosition);
		clone.position.y -= 0.57;
		clone.quaternion.copy(this.quaternion);
		clone.scale.copy(this.scale);
		clone.userData = { opacity: 0.75, fadeSpeed: 0.55 };

		clone.traverse((node: any) =>
		{
			if (node.isMesh)
			{
				const originalMat = node.material;
				const mats = Array.isArray(originalMat) ? originalMat : [originalMat];
				const newMats = mats.map((mat: any) =>
				{
					const m = mat.clone ? mat.clone() : new THREE.MeshBasicMaterial({ color: 0x030507 });
					m.transparent = true;
					m.opacity = 0.75;
					m.depthWrite = false;
					if (m.color) m.color.set('#030507');
					return m;
				});
				node.material = Array.isArray(originalMat) ? newMats : newMats[0];

				// Blue outline via slightly larger inverted/emissive shell
				if (node.geometry)
				{
					const outline = node.clone();
					outline.scale.multiplyScalar(1.06);
					const outlineMat = new THREE.MeshBasicMaterial({
						color: 0x168cff,
						transparent: true,
						opacity: 0.65,
						side: THREE.BackSide,
						depthWrite: false
					});
					outline.material = outlineMat;
					outline.userData = { isOutline: true };
					node.add(outline);
				}
			}
		});

		// Limit trail length
		while (this.moderatorTrail.children.length > 18)
		{
			const oldest = this.moderatorTrail.children[0];
			this.moderatorTrail.remove(oldest);
			oldest.traverse((node: any) =>
			{
				if (node.geometry) node.geometry.dispose();
				if (node.material)
				{
					const mats = Array.isArray(node.material) ? node.material : [node.material];
					mats.forEach((mat: any) => mat.dispose && mat.dispose());
				}
			});
		}

		this.moderatorTrail.add(clone);
	}

	public setArcadeVelocityInfluence(x: number, y: number = x, z: number = x): void
	{
		this.arcadeVelocityInfluence.set(x, y, z);
	}

	public setViewVector(vector: THREE.Vector3): void
	{
		this.viewVector.copy(vector).normalize();
	}

	/**
	 * Set state to the player. Pass state class (function) name.
	 * @param {function} State 
	 */
	public setState(state: ICharacterState): void
	{
		this.charState = state;
		this.charState.onInputChange();
	}

	public setPosition(x: number, y: number, z: number): void
	{
		if (this.physicsEnabled)
		{
			this.characterCapsule.body.previousPosition = new CANNON.Vec3(x, y, z);
			this.characterCapsule.body.position = new CANNON.Vec3(x, y, z);
			this.characterCapsule.body.interpolatedPosition = new CANNON.Vec3(x, y, z);
		}
		else
		{
			this.position.x = x;
			this.position.y = y;
			this.position.z = z;
		}
	}

	public resetVelocity(): void
	{
		this.velocity.x = 0;
		this.velocity.y = 0;
		this.velocity.z = 0;

		this.characterCapsule.body.velocity.x = 0;
		this.characterCapsule.body.velocity.y = 0;
		this.characterCapsule.body.velocity.z = 0;

		this.velocitySimulator.init();
	}

	public setArcadeVelocityTarget(velZ: number, velX: number = 0, velY: number = 0): void
	{
		this.velocityTarget.z = velZ;
		this.velocityTarget.x = velX;
		this.velocityTarget.y = velY;
	}

	public setOrientation(vector: THREE.Vector3, instantly: boolean = false): void
	{
		let lookVector = new THREE.Vector3().copy(vector).setY(0).normalize();
		this.orientationTarget.copy(lookVector);
		
		if (instantly)
		{
			this.orientation.copy(lookVector);
		}
	}

	public resetOrientation(): void
	{
		const forward = Utils.getForward(this);
		this.setOrientation(forward, true);
	}

	public setBehaviour(behaviour: ICharacterAI): void
	{
		behaviour.character = this;
		this.behaviour = behaviour;
	}

	public setPhysicsEnabled(value: boolean): void {
		this.physicsEnabled = value;
		if (this.world === undefined) return;

		if (value === true)
		{
			this.world.physicsWorld.addBody(this.characterCapsule.body);
		}
		else
		{
			this.world.physicsWorld.remove(this.characterCapsule.body);
		}
	}

	public readCharacterData(gltf: any): void
	{
		gltf.scene.traverse((child) => {

			if (child.isMesh)
			{
				Utils.setupMeshProperties(child);

				if (child.material !== undefined)
				{
					this.materials.push(child.material);
				}
			}
		});
	}

	public handleKeyboardEvent(event: KeyboardEvent, code: string, pressed: boolean): void
	{
		if (this.controlledObject !== undefined)
		{
			this.controlledObject.handleKeyboardEvent(event, code, pressed);
		}
		else
		{
			if (code === 'KeyV' && pressed === true)
			{
				this.isFirstPerson = !this.isFirstPerson;
				this.world.cameraOperator.setFirstPersonCharacter(this.isFirstPerson ? this : undefined);
				return;
			}
			// Free camera
			if (code === 'KeyC' && pressed === true && event.shiftKey === true)
			{
				this.resetControls();
				this.world.cameraOperator.characterCaller = this;
				this.world.inputManager.setInputReceiver(this.world.cameraOperator);
			}
			else if (code === 'KeyR' && pressed === true && event.shiftKey === true)
			{
				this.world.restartScenario();
			}
			else
			{
				for (const action in this.actions) {
					if (this.actions.hasOwnProperty(action)) {
						const binding = this.actions[action];
	
						if (_.includes(binding.eventCodes, code))
						{
							this.triggerAction(action, pressed);
						}
					}
				}
			}
		}
	}

	public handleMouseButton(event: MouseEvent, code: string, pressed: boolean): void
	{
		if (this.controlledObject !== undefined)
		{
			this.controlledObject.handleMouseButton(event, code, pressed);
		}
		else
		{
			for (const action in this.actions) {
				if (this.actions.hasOwnProperty(action)) {
					const binding = this.actions[action];

					if (_.includes(binding.eventCodes, code))
					{
						this.triggerAction(action, pressed);
					}
				}
			}
		}
	}

	public handleMouseMove(event: MouseEvent, deltaX: number, deltaY: number): void
	{
		if (this.controlledObject !== undefined)
		{
			this.controlledObject.handleMouseMove(event, deltaX, deltaY);
		}
		else
		{
			this.world.cameraOperator.move(deltaX, deltaY);
		}
	}
	
	public handleMouseWheel(event: WheelEvent, value: number): void
	{
		if (this.controlledObject !== undefined)
		{
			this.controlledObject.handleMouseWheel(event, value);
		}
		else
		{
			this.world.scrollTheTimeScale(value);
		}
	}

	public triggerAction(actionName: string, value: boolean): void
	{
		// Get action and set it's parameters
		let action = this.actions[actionName];

		if (action.isPressed !== value)
		{
			// Set value
			action.isPressed = value;

			// Reset the 'just' attributes
			action.justPressed = false;
			action.justReleased = false;

			// Set the 'just' attributes
			if (value) action.justPressed = true;
			else action.justReleased = true;

			// Tell player to handle states according to new input
			this.charState.onInputChange();

			// Reset the 'just' attributes
			action.justPressed = false;
			action.justReleased = false;
		}
	}

	public takeControl(): void
	{
		if (this.world !== undefined)
		{
			this.world.inputManager.setInputReceiver(this);
			this.createHealthBar();
		}
		else
		{
			console.warn('Attempting to take control of a character that doesn\'t belong to a world.');
		}
	}

	public resetControls(): void
	{
		for (const action in this.actions) {
			if (this.actions.hasOwnProperty(action)) {
				this.triggerAction(action, false);
			}
		}
	}

	public update(timeStep: number): void
	{
		if (this.isDead)
		{
			// Keep animation mixer going but stop physics/input driven movement
			if (this.mixer) this.mixer.update(timeStep);
			if (this.characterCapsule) this.characterCapsule.body.velocity.set(0, this.characterCapsule.body.velocity.y, 0);
			return;
		}

		// Continuously sync aim state from secondary (right mouse hold)
		if (this.actions && this.actions.secondary)
		{
			const shouldAim = this.actions.secondary.isPressed === true;
			if (shouldAim !== this.isAiming) this.setAiming(shouldAim);
		}

		this.vehicleHitCooldown = Math.max(0, this.vehicleHitCooldown - timeStep);
		if (this.moderatorSkinEnabled && this.moderatorTrail !== undefined)
		{
			this.moderatorTrailAge += timeStep;
			const currentPosition = this.getWorldPosition(new THREE.Vector3());
			if (this.moderatorTrailInitialized && currentPosition.distanceTo(this.moderatorTrailPosition) > 0.35 && this.moderatorTrailAge > 0.12)
			{
				this.spawnModeratorSkinTrail(currentPosition);
				this.moderatorTrailPosition.copy(currentPosition);
				this.moderatorTrailAge = 0;
			}
			this.moderatorTrail.children.slice().forEach((child: THREE.Object3D) =>
			{
				const userData = child.userData as any;
				if (userData.fadeSpeed !== undefined)
				{
					userData.opacity -= timeStep * userData.fadeSpeed;
					child.traverse((node: any) =>
					{
						if (node.material)
						{
							const mats = Array.isArray(node.material) ? node.material : [node.material];
							mats.forEach((mat: any) =>
							{
								if (mat.opacity !== undefined) mat.opacity = Math.max(0, userData.opacity);
								if (mat.transparent !== undefined) mat.transparent = true;
							});
						}
					});
					if (userData.opacity <= 0)
					{
						this.moderatorTrail.remove(child);
						child.traverse((node: any) =>
						{
							if (node.geometry) node.geometry.dispose();
							if (node.material)
							{
								const mats = Array.isArray(node.material) ? node.material : [node.material];
								mats.forEach((mat: any) => mat.dispose && mat.dispose());
							}
						});
					}
				}
			});
		}
		if (this.isFrozen)
		{
			this.velocityTarget.set(0, 0, 0);
			this.resetVelocity();
			return;
		}
		this.behaviour?.update(timeStep);
		this.vehicleEntryInstance?.update(timeStep);
		// console.log(this.occupyingSeat);
		if (!this.isRemote) this.charState?.update(timeStep);

		// When flying, match sprint horizontal speed
		if (this.isFlying && this.controlledObject === undefined && !this.isRemote)
		{
			const hasDir = this.actions.up.isPressed || this.actions.down.isPressed || this.actions.left.isPressed || this.actions.right.isPressed;
			this.setArcadeVelocityTarget(hasDir ? 1.4 : 0);
			this.setArcadeVelocityInfluence(1, 0, 1);
		}

		// this.visuals.position.copy(this.modelOffset);
		if (this.physicsEnabled) this.springMovement(timeStep);
		if (this.physicsEnabled) this.springRotation(timeStep);
		if (this.physicsEnabled) this.rotateModel();
		if (this.mixer !== undefined) this.mixer.update(timeStep);

		// Sync physics/graphics
		if (this.physicsEnabled)
		{
			if (this.isFlying && this.controlledObject === undefined)
			{
				this.characterCapsule.body.velocity.y = this.actions.jump.isPressed ? 6 : this.actions.down.isPressed ? -6 : 0;
			}
			this.position.set(
				this.characterCapsule.body.interpolatedPosition.x,
				this.characterCapsule.body.interpolatedPosition.y,
				this.characterCapsule.body.interpolatedPosition.z
			);
		}
		else {
			let newPos = new THREE.Vector3();
			this.getWorldPosition(newPos);

			this.characterCapsule.body.position.copy(Utils.cannonVector(newPos));
			this.characterCapsule.body.interpolatedPosition.copy(Utils.cannonVector(newPos));
		}

		this.updateMatrixWorld();
	}

	public hitByVehicle(vehicle: Vehicle): void
	{
		if (this.isRemote || this.vehicleHitCooldown > 0 || this.occupyingSeat !== null) return;
		if (vehicle.collision.velocity.length() < 2) return;

		this.vehicleHitCooldown = 1;
		this.characterCapsule.body.velocity.x = vehicle.collision.velocity.x * 0.75;
		this.characterCapsule.body.velocity.y = 4;
		this.characterCapsule.body.velocity.z = vehicle.collision.velocity.z * 0.75;
		this.setState(new VehicleHit(this));
	}

	public hitByFall(): void
	{
		if (this.vehicleHitCooldown > 0 || this.occupyingSeat !== null || this.isRemote) return;
		this.vehicleHitCooldown = 1;
		this.setState(new VehicleHit(this));
	}

	public applyTPose(): void
	{
		this.modelContainer.traverse((child: any) =>
		{
			const name = (child.name || '').toLowerCase();
			if (name === 'arm_upper.l') child.rotation.z = -Math.PI / 2;
			if (name === 'arm_upper.r') child.rotation.z = Math.PI / 2;
		});
	}

	public inputReceiverInit(): void
	{
		if (this.controlledObject !== undefined)
		{
			this.controlledObject.inputReceiverInit();
			return;
		}

		this.world.cameraOperator.setRadius(1.6, true);
		this.world.cameraOperator.followMode = false;
		// this.world.dirLight.target = this;

		this.displayControls();
	}

	public displayControls(): void
	{
		this.world.updateControls([
			{
				keys: ['W', 'A', 'S', 'D'],
				desc: 'Movement'
			},
			{
				keys: ['Shift'],
				desc: 'Sprint'
			},
			{
				keys: ['Space'],
				desc: 'Jump'
			},
			{
				keys: ['F', 'or', 'G'],
				desc: 'Enter vehicle'
			},
			{
				keys: ['V'],
				desc: 'First-person view'
			},
			{
				keys: ['Shift', '+', 'R'],
				desc: 'Respawn'
			},
			{
				keys: ['Shift', '+', 'C'],
				desc: 'Free camera'
			},
		]);
	}

	public inputReceiverUpdate(timeStep: number): void
	{
		if (this.controlledObject !== undefined)
		{
			this.controlledObject.inputReceiverUpdate(timeStep);
		}
		else
		{
			// Look in camera's direction
			this.viewVector = new THREE.Vector3().subVectors(this.position, this.world.camera.position);
			this.getWorldPosition(this.world.cameraOperator.target);
		}
		
	}

	public setAnimation(clipName: string, fadeIn: number): number
	{
		if (this.mixer !== undefined)
		{
			// gltf
			let clip = THREE.AnimationClip.findByName( this.animations, clipName );

			let action = this.mixer.clipAction(clip);
			if (action === null)
			{
				console.error(`Animation ${clipName} not found!`);
				return 0;
			}

			this.currentAnimName = clipName;
			this.mixer.stopAllAction();
			action.fadeIn(fadeIn);
			action.play();

			return action.getClip().duration;
		}
	}

	public springMovement(timeStep: number): void
	{
		// Simulator
		this.velocitySimulator.target.copy(this.velocityTarget);
		this.velocitySimulator.simulate(timeStep);

		// Update values
		this.velocity.copy(this.velocitySimulator.position);
		this.acceleration.copy(this.velocitySimulator.velocity);
	}

	public springRotation(timeStep: number): void
	{
		// Spring rotation
		// Figure out angle between current and target orientation
		let angle = Utils.getSignedAngleBetweenVectors(this.orientation, this.orientationTarget);

		// Simulator
		this.rotationSimulator.target = angle;
		this.rotationSimulator.simulate(timeStep);
		let rot = this.rotationSimulator.position;

		// Updating values
		this.orientation.applyAxisAngle(new THREE.Vector3(0, 1, 0), rot);
		this.angularVelocity = this.rotationSimulator.velocity;
	}

	public getLocalMovementDirection(): THREE.Vector3
	{
		const positiveX = this.actions.right.isPressed ? -1 : 0;
		const negativeX = this.actions.left.isPressed ? 1 : 0;
		const positiveZ = this.actions.up.isPressed ? 1 : 0;
		const negativeZ = this.actions.down.isPressed ? -1 : 0;

		return new THREE.Vector3(positiveX + negativeX, 0, positiveZ + negativeZ).normalize();
	}

	public getCameraRelativeMovementVector(): THREE.Vector3
	{
		const localDirection = this.getLocalMovementDirection();
		const flatViewVector = new THREE.Vector3(this.viewVector.x, 0, this.viewVector.z).normalize();

		return Utils.appplyVectorMatrixXZ(flatViewVector, localDirection);
	}

	public setCameraRelativeOrientationTarget(): void
	{
		if (this.vehicleEntryInstance === null)
		{
			let moveVector = this.getCameraRelativeMovementVector();
	
			if (moveVector.x === 0 && moveVector.y === 0 && moveVector.z === 0)
			{
				this.setOrientation(this.orientation);
			}
			else
			{
				this.setOrientation(moveVector);
			}
		}
	}

	public rotateModel(): void
	{
		this.lookAt(this.position.x + this.orientation.x, this.position.y + this.orientation.y, this.position.z + this.orientation.z);
		this.tiltContainer.rotation.z = (-this.angularVelocity * 2.3 * this.velocity.length());
		this.tiltContainer.position.setY((Math.cos(Math.abs(this.angularVelocity * 2.3 * this.velocity.length())) / 2) - 0.5);
	}

	public jump(initJumpSpeed: number = -1): void
	{
		this.wantsToJump = true;
		this.initJumpSpeed = initJumpSpeed;
	}

	public findVehicleToEnter(wantsToDrive: boolean): void
	{
		// reusable world position variable
		let worldPos = new THREE.Vector3();

		// Find best vehicle
		let vehicleFinder = new ClosestObjectFinder<Vehicle>(this.position, 10);
		this.world.vehicles.forEach((vehicle) =>
		{
			vehicleFinder.consider(vehicle, vehicle.position);
		});

		if (vehicleFinder.closestObject !== undefined)
		{
			let vehicle = vehicleFinder.closestObject;
			let vehicleEntryInstance = new VehicleEntryInstance(this);
			vehicleEntryInstance.wantsToDrive = wantsToDrive;

			// Find best seat
			let seatFinder = new ClosestObjectFinder<VehicleSeat>(this.position);
			for (const seat of vehicle.seats)
			{
				if (wantsToDrive)
				{
					// Consider driver seats
					if (seat.type === SeatType.Driver)
					{
						if (seat.occupiedBy !== null) continue;
						seat.seatPointObject.getWorldPosition(worldPos);
						seatFinder.consider(seat, worldPos);
					}
					// Consider passenger seats connected to driver seats
					else if (seat.type === SeatType.Passenger)
					{
						for (const connSeat of seat.connectedSeats)
						{
							if (connSeat.type === SeatType.Driver)
							{
								seat.seatPointObject.getWorldPosition(worldPos);
								seatFinder.consider(seat, worldPos);
								break;
							}
						}
					}
				}
				else
				{
					// Consider passenger seats
					if (seat.type === SeatType.Passenger)
					{
						if (seat.occupiedBy !== null) continue;
						seat.seatPointObject.getWorldPosition(worldPos);
						seatFinder.consider(seat, worldPos);
					}
				}
			}

			if (seatFinder.closestObject !== undefined)
			{
				let targetSeat = seatFinder.closestObject;
				vehicleEntryInstance.targetSeat = targetSeat;

				let entryPointFinder = new ClosestObjectFinder<Object3D>(this.position);

				for (const point of targetSeat.entryPoints) {
					point.getWorldPosition(worldPos);
					entryPointFinder.consider(point, worldPos);
				}

				if (entryPointFinder.closestObject !== undefined)
				{
					vehicleEntryInstance.entryPoint = entryPointFinder.closestObject;
					this.triggerAction('up', true);
					this.vehicleEntryInstance = vehicleEntryInstance;
				}
			}
		}
	}

	public enterVehicle(seat: VehicleSeat, entryPoint: THREE.Object3D): void
	{
		this.resetControls();

		if (seat.door?.rotation < 0.5)
		{
			this.setState(new OpenVehicleDoor(this, seat, entryPoint));
		}
		else
		{
			this.setState(new EnteringVehicle(this, seat, entryPoint));
		}
	}

	public teleportToVehicle(vehicle: Vehicle, seat: VehicleSeat): void
	{
		this.resetVelocity();
		this.rotateModel();
		this.setPhysicsEnabled(false);
		(vehicle as unknown as THREE.Object3D).attach(this);

		this.setPosition(seat.seatPointObject.position.x, seat.seatPointObject.position.y + 0.6, seat.seatPointObject.position.z);
		this.quaternion.copy(seat.seatPointObject.quaternion);

		this.occupySeat(seat);
		this.setState(new Driving(this, seat));

		this.startControllingVehicle(vehicle, seat);
	}

	public startControllingVehicle(vehicle: IControllable, seat: VehicleSeat): void
	{
		if (this.controlledObject !== vehicle)
		{
			this.transferControls(vehicle);
			this.resetControls();
	
			this.controlledObject = vehicle;
			this.controlledObject.allowSleep(false);
			vehicle.inputReceiverInit();
	
			vehicle.controllingCharacter = this;
		}
	}

	public transferControls(entity: IControllable): void
	{
		// Currently running through all actions of this character and the vehicle,
		// comparing keycodes of actions and based on that triggering vehicle's actions
		// Maybe we should ask input manager what's the current state of the keyboard
		// and read those values... TODO
		for (const action1 in this.actions) {
			if (this.actions.hasOwnProperty(action1)) {
				for (const action2 in entity.actions) {
					if (entity.actions.hasOwnProperty(action2)) {

						let a1 = this.actions[action1];
						let a2 = entity.actions[action2];

						a1.eventCodes.forEach((code1) => {
							a2.eventCodes.forEach((code2) => {
								if (code1 === code2)
								{
									entity.triggerAction(action2, a1.isPressed);
								}
							});
						});
					}
				}
			}
		}
	}

	public stopControllingVehicle(): void
	{
		if (this.controlledObject?.controllingCharacter === this)
		{
			this.controlledObject.allowSleep(true);
			this.controlledObject.controllingCharacter = undefined;
			this.controlledObject.resetControls();
			this.controlledObject = undefined;
			this.inputReceiverInit();
		}
	}

	public exitVehicle(): void
	{
		if (this.occupyingSeat !== null)
		{
			if (this.occupyingSeat.vehicle.entityType === EntityType.Airplane)
			{
				this.setState(new ExitingAirplane(this, this.occupyingSeat));
			}
			else
			{
				this.setState(new ExitingVehicle(this, this.occupyingSeat));
			}
			
			this.stopControllingVehicle();
		}
	}

	public occupySeat(seat: VehicleSeat): void
	{
		this.occupyingSeat = seat;
		seat.occupiedBy = this;
	}

	public leaveSeat(): void
	{
		if (this.occupyingSeat !== null)
		{
			this.occupyingSeat.occupiedBy = null;
			this.occupyingSeat = null;
		}
	}

	public physicsPreStep(body: CANNON.Body, character: Character): void
	{
		character.feetRaycast();

		// Raycast debug
		if (character.rayHasHit)
		{
			if (character.raycastBox.visible) {
				character.raycastBox.position.x = character.rayResult.hitPointWorld.x;
				character.raycastBox.position.y = character.rayResult.hitPointWorld.y;
				character.raycastBox.position.z = character.rayResult.hitPointWorld.z;
			}
		}
		else
		{
			if (character.raycastBox.visible) {
				character.raycastBox.position.set(body.position.x, body.position.y - character.rayCastLength - character.raySafeOffset, body.position.z);
			}
		}
	}

	public feetRaycast(): void
	{
		// Player ray casting
		// Create ray
		let body = this.characterCapsule.body;
		const start = new CANNON.Vec3(body.position.x, body.position.y, body.position.z);
		const end = new CANNON.Vec3(body.position.x, body.position.y - this.rayCastLength - this.raySafeOffset, body.position.z);
		// Raycast options
		const rayCastOptions = {
			collisionFilterMask: CollisionGroups.Default,
			skipBackfaces: true      /* ignore back faces */
		};
		// Cast the ray
		this.rayHasHit = this.world.physicsWorld.raycastClosest(start, end, rayCastOptions, this.rayResult);
	}

	public physicsPostStep(body: CANNON.Body, character: Character): void
	{
		// Get velocities
		let simulatedVelocity = new THREE.Vector3(body.velocity.x, body.velocity.y, body.velocity.z);

		// Take local velocity (slowed players move at half speed)
		const effectiveSpeed = character.isSlowed ? character.moveSpeed * 0.35 : character.moveSpeed;
		let arcadeVelocity = new THREE.Vector3().copy(character.velocity).multiplyScalar(effectiveSpeed);
		// Turn local into global
		arcadeVelocity = Utils.appplyVectorMatrixXZ(character.orientation, arcadeVelocity);

		let newVelocity = new THREE.Vector3();

		// Additive velocity mode
		if (character.arcadeVelocityIsAdditive)
		{
			newVelocity.copy(simulatedVelocity);

			let globalVelocityTarget = Utils.appplyVectorMatrixXZ(character.orientation, character.velocityTarget);
			let add = new THREE.Vector3().copy(arcadeVelocity).multiply(character.arcadeVelocityInfluence);

			if (Math.abs(simulatedVelocity.x) < Math.abs(globalVelocityTarget.x * effectiveSpeed) || Utils.haveDifferentSigns(simulatedVelocity.x, arcadeVelocity.x)) { newVelocity.x += add.x; }
			if (Math.abs(simulatedVelocity.y) < Math.abs(globalVelocityTarget.y * effectiveSpeed) || Utils.haveDifferentSigns(simulatedVelocity.y, arcadeVelocity.y)) { newVelocity.y += add.y; }
			if (Math.abs(simulatedVelocity.z) < Math.abs(globalVelocityTarget.z * effectiveSpeed) || Utils.haveDifferentSigns(simulatedVelocity.z, arcadeVelocity.z)) { newVelocity.z += add.z; }
		}
		else
		{
			newVelocity = new THREE.Vector3(
				THREE.MathUtils.lerp(simulatedVelocity.x, arcadeVelocity.x, character.arcadeVelocityInfluence.x),
				THREE.MathUtils.lerp(simulatedVelocity.y, arcadeVelocity.y, character.arcadeVelocityInfluence.y),
				THREE.MathUtils.lerp(simulatedVelocity.z, arcadeVelocity.z, character.arcadeVelocityInfluence.z),
			);
		}

		// If we're hitting the ground, stick to ground
		if (character.rayHasHit)
		{
			// Flatten velocity
			newVelocity.y = 0;

			// Move on top of moving objects
			if (character.rayResult.body.mass > 0)
			{
				let pointVelocity = new CANNON.Vec3();
				character.rayResult.body.getVelocityAtWorldPoint(character.rayResult.hitPointWorld, pointVelocity);
				newVelocity.add(Utils.threeVector(pointVelocity));
			}

			// Measure the normal vector offset from direct "up" vector
			// and transform it into a matrix
			let up = new THREE.Vector3(0, 1, 0);
			let normal = new THREE.Vector3(character.rayResult.hitNormalWorld.x, character.rayResult.hitNormalWorld.y, character.rayResult.hitNormalWorld.z);
			let q = new THREE.Quaternion().setFromUnitVectors(up, normal);
			let m = new THREE.Matrix4().makeRotationFromQuaternion(q);

			// Rotate the velocity vector
			newVelocity.applyMatrix4(m);

			// Compensate for gravity
			// newVelocity.y -= body.world.physicsWorld.gravity.y / body.character.world.physicsFrameRate;

			// Apply velocity
			body.velocity.x = newVelocity.x;
			body.velocity.y = newVelocity.y;
			body.velocity.z = newVelocity.z;
			// Ground character
			body.position.y = character.rayResult.hitPointWorld.y + character.rayCastLength + (newVelocity.y / character.world.physicsFrameRate);
		}
		else
		{
			// If we're in air
			body.velocity.x = newVelocity.x;
			body.velocity.y = newVelocity.y;
			body.velocity.z = newVelocity.z;

			// Save last in-air information
			character.groundImpactData.velocity.x = body.velocity.x;
			character.groundImpactData.velocity.y = body.velocity.y;
			character.groundImpactData.velocity.z = body.velocity.z;
		}

		// Jumping
		if (character.wantsToJump)
		{
			// If initJumpSpeed is set
			if (character.initJumpSpeed > -1)
			{
				// Flatten velocity
				body.velocity.y = 0;
				let speed = Math.max(character.velocitySimulator.position.length() * 4, character.initJumpSpeed);
				body.velocity = Utils.cannonVector(character.orientation.clone().multiplyScalar(speed));
			}
			else {
				// Moving objects compensation
				let add = new CANNON.Vec3();
				character.rayResult.body.getVelocityAtWorldPoint(character.rayResult.hitPointWorld, add);
				body.velocity.vsub(add, body.velocity);
			}

			// Add positive vertical velocity 
			body.velocity.y += 4;
			// Move above ground by 2x safe offset value
			body.position.y += character.raySafeOffset * 2;
			// Reset flag
			character.wantsToJump = false;
		}
	}

	public addToWorld(world: World): void
	{
		if (_.includes(world.characters, this))
		{
			console.warn('Adding character to a world in which it already exists.');
		}
		else
		{
			// Set world
			this.world = world;

			// Register character
			world.characters.push(this);

			// Register physics for locally simulated characters only
			if (this.physicsEnabled) world.physicsWorld.addBody(this.characterCapsule.body);

			// Add to graphicsWorld
			world.graphicsWorld.add(this);
			world.graphicsWorld.add(this.raycastBox);

			// Shadow cascades
			this.materials.forEach((mat) =>
			{
				world.sky.csm.setupMaterial(mat);
			});
		}
	}

	public removeFromWorld(world: World): void
	{
		if (!_.includes(world.characters, this))
		{
			console.warn('Removing character from a world in which it isn\'t present.');
		}
		else
		{
			if (world.inputManager.inputReceiver === this)
			{
				world.inputManager.inputReceiver = undefined;
			}

			this.world = undefined;

			// Remove from characters
			_.pull(world.characters, this);

			// Remove physics
			world.physicsWorld.remove(this.characterCapsule.body);

			// Remove visuals
			world.graphicsWorld.remove(this);
			world.graphicsWorld.remove(this.raycastBox);

			// Clean up blood splatters belonging to this character
			this.bloodSpatters.forEach(s => {
				if (s.parent) s.parent.remove(s);
			});
			this.bloodSpatters = [];
		}
	}

	/** Apply damage. Returns true if the character died from this hit. */
	public takeDamage(amount: number, attacker: Character = null): boolean
	{
		if (this.isDead || this.isFrozen) return false;

		this.health = Math.max(0, this.health - amount);
		this.updateHealthBar();
		this.spawnBloodSpatter();

		if (this.health <= 0)
		{
			this.die(attacker);
			return true;
		}
		return false;
	}

	public die(killer: Character = null): void
	{
		if (this.isDead) return;
		this.isDead = true;
		this.isAiming = false;
		this.health = 0;
		this.updateHealthBar();
		this.updateAimCrosshair();

		this.setArcadeVelocityTarget(0);
		this.velocity.set(0, 0, 0);
		if (this.characterCapsule) this.characterCapsule.body.velocity.set(0, 0, 0);

		// Switch to Death state (handles animation + tilt)
		this.setState(new Death(this));

		console.log('Character died', killer ? 'killed by another player' : '');
	}

	public revive(): void
	{
		this.isDead = false;
		this.health = this.maxHealth;
		if (this.tiltContainer) this.tiltContainer.rotation.z = 0;
		this.updateHealthBar();
		this.setState(new Idle(this));
	}

	/**
	 * Called from input when player presses attack while aiming.
	 * Enters Attack state (animation) which then calls performMeleeHit().
	 */
	public tryAttack(): void
	{
		if (this.isDead || this.controlledObject || this.occupyingSeat) return;
		if (!this.isAiming) return; // must be aiming – no auto / free fire

		const now = performance.now() / 1000;
		if (now - this.lastAttackTime < this.attackCooldown) return;
		this.lastAttackTime = now;

		this.setState(new Attack(this));
	}

	/**
	 * Actual hit detection + damage + tackle physics.
	 * Called by Attack state on enter.
	 */
	public performMeleeHit(): void
	{
		const direction = this.orientation.clone().normalize();
		let closest: Character = null;
		let closestDist = this.attackRange;

		if (this.world && this.world.characters)
		{
			for (const other of this.world.characters)
			{
				if (other === this || other.isDead) continue;

				const toOther = other.position.clone().sub(this.position);
				const dist = toOther.length();
				if (dist > this.attackRange || dist < 0.15) continue;

				toOther.y = 0;
				toOther.normalize();
				const dot = direction.dot(toOther);
				if (dot < 0.35) continue; // must be roughly in front

				if (dist < closestDist)
				{
					closestDist = dist;
					closest = other;
				}
			}
		}

		if (closest)
		{
			// Local damage application
			closest.takeDamage(this.attackDamage, this);

			// Network: notify multiplayer layer so other clients apply the same damage
			if (this.onDamageDealt && closest.networkId)
			{
				this.onDamageDealt(closest.networkId, this.attackDamage);
			}

			// Tackle impulse (only if target has physics)
			if (closest.characterCapsule && closest.characterCapsule.body && !closest.isRemote)
			{
				const pushDir = closest.position.clone().sub(this.position).normalize();
				pushDir.y = 0.3;
				const impulse = Utils.cannonVector(pushDir.multiplyScalar(this.tackleForce));
				closest.characterCapsule.body.velocity.vadd(impulse, closest.characterCapsule.body.velocity);
			}

			// Small self knockback
			if (this.characterCapsule)
			{
				const selfPush = direction.clone().multiplyScalar(-1.2);
				this.characterCapsule.body.velocity.vadd(Utils.cannonVector(selfPush), this.characterCapsule.body.velocity);
			}
		}
	}

	/** Enter / exit aim mode (hold right mouse). */
	public setAiming(aiming: boolean): void
	{
		if (this.isDead) aiming = false;
		this.isAiming = aiming;
		this.updateAimCrosshair();

		if (aiming)
		{
			// Slightly slower move while aiming
			this.moveSpeed = Math.min(this.moveSpeed, 2.8);
		}
		else if (!this.isSlowed)
		{
			this.moveSpeed = 4;
		}
	}

	public spawnBloodSpatter(): void
	{
		if (!this.world) return;

		const geo = new THREE.CircleGeometry(0.15 + Math.random() * 0.25, 8);
		const mat = new THREE.MeshBasicMaterial({
			color: 0x8b0000,
			transparent: true,
			opacity: 0.85,
			side: THREE.DoubleSide,
			depthWrite: false
		});
		const splat = new THREE.Mesh(geo, mat);
		splat.rotation.x = -Math.PI / 2;
		splat.position.copy(this.position);
		splat.position.y += 0.02;
		splat.position.x += (Math.random() - 0.5) * 0.4;
		splat.position.z += (Math.random() - 0.5) * 0.4;

		this.world.graphicsWorld.add(splat);
		this.bloodSpatters.push(splat);

		// Fade out and remove after a while
		const start = performance.now();
		const duration = 8000 + Math.random() * 4000;
		const fade = () => {
			const t = (performance.now() - start) / duration;
			if (t >= 1)
			{
				if (splat.parent) splat.parent.remove(splat);
				const idx = this.bloodSpatters.indexOf(splat);
				if (idx >= 0) this.bloodSpatters.splice(idx, 1);
				return;
			}
			mat.opacity = 0.85 * (1 - t);
			requestAnimationFrame(fade);
		};
		requestAnimationFrame(fade);
	}

	public createHealthBar(): void
	{
		if (this.healthBarElement) return;

		const bar = document.createElement('div');
		bar.id = 'player-health-bar';
		bar.style.cssText = `
			position: fixed;
			bottom: 30px;
			left: 50%;
			transform: translateX(-50%);
			width: 260px;
			height: 22px;
			background: rgba(0,0,0,0.6);
			border: 2px solid #222;
			border-radius: 6px;
			overflow: hidden;
			z-index: 1000;
			pointer-events: none;
			box-shadow: 0 2px 8px rgba(0,0,0,0.5);
		`;

		const fill = document.createElement('div');
		fill.id = 'player-health-fill';
		fill.style.cssText = `
			width: 100%;
			height: 100%;
			background: linear-gradient(90deg, #c0392b, #e74c3c);
			transition: width 0.2s ease, background 0.3s;
		`;

		const label = document.createElement('div');
		label.id = 'player-health-label';
		label.style.cssText = `
			position: absolute;
			top: 0; left: 0; right: 0; bottom: 0;
			display: flex;
			align-items: center;
			justify-content: center;
			color: white;
			font-family: Arial, sans-serif;
			font-size: 12px;
			font-weight: bold;
			text-shadow: 0 1px 2px #000;
		`;
		label.textContent = '100 / 100';

		bar.appendChild(fill);
		bar.appendChild(label);
		document.body.appendChild(bar);

		this.healthBarElement = bar;
		this.updateHealthBar();
		this.createAimCrosshair();
	}

	public updateHealthBar(): void
	{
		if (!this.healthBarElement) return;

		const fill = document.getElementById('player-health-fill');
		const label = document.getElementById('player-health-label');
		if (!fill || !label) return;

		const pct = Math.max(0, Math.min(100, (this.health / this.maxHealth) * 100));
		fill.style.width = pct + '%';

		if (pct > 60) fill.style.background = 'linear-gradient(90deg, #27ae60, #2ecc71)';
		else if (pct > 30) fill.style.background = 'linear-gradient(90deg, #f39c12, #f1c40f)';
		else fill.style.background = 'linear-gradient(90deg, #c0392b, #e74c3c)';

		label.textContent = Math.ceil(this.health) + ' / ' + this.maxHealth;

		if (this.isDead)
		{
			label.textContent = 'DEAD';
			fill.style.width = '0%';
		}
	}

	public createAimCrosshair(): void
	{
		if (this.aimCrosshair) return;

		const el = document.createElement('div');
		el.id = 'aim-crosshair';
		el.style.cssText = `
			position: fixed;
			top: 50%;
			left: 50%;
			width: 18px;
			height: 18px;
			margin: -9px 0 0 -9px;
			border: 2px solid rgba(255,255,255,0.85);
			border-radius: 50%;
			box-shadow: 0 0 4px #000, inset 0 0 2px #000;
			pointer-events: none;
			z-index: 999;
			display: none;
			opacity: 0.9;
		`;
		// center dot
		const dot = document.createElement('div');
		dot.style.cssText = `
			position: absolute;
			top: 50%; left: 50%;
			width: 3px; height: 3px;
			margin: -1.5px 0 0 -1.5px;
			background: #fff;
			border-radius: 50%;
			box-shadow: 0 0 2px #000;
		`;
		el.appendChild(dot);
		document.body.appendChild(el);
		this.aimCrosshair = el;
	}

	public updateAimCrosshair(): void
	{
		if (!this.aimCrosshair) this.createAimCrosshair();
		if (this.aimCrosshair)
		{
			this.aimCrosshair.style.display = (this.isAiming && !this.isDead) ? 'block' : 'none';
		}
	}
}