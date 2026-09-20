const firebaseModule: any = require('firebase/app');
const firebase: any = firebaseModule.default || firebaseModule;
require('firebase/database');
import * as THREE from 'three';
import * as CANNON from 'cannon';

import { World } from '../world/World';
import { Character } from '../characters/Character';
import { Vehicle } from '../vehicles/Vehicle';
import { Car } from '../vehicles/Car';
import { PickupTruck } from '../vehicles/PickupTruck';
import { Airplane } from '../vehicles/Airplane';
import { Helicopter } from '../vehicles/Helicopter';
import { LoadingManager } from './LoadingManager';
import { FollowTarget } from '../characters/character_ai/FollowTarget';

interface OnlinePlayerState
{
	name: string;
	x: number;
	y: number;
	z: number;
	qx: number;
	qy: number;
	qz: number;
	qw: number;
	vehicleType?: string;
	moving?: boolean;
	updatedAt: number;
	color?: string;
	moderator?: boolean;
	vehicleId?: string;
	seatName?: string;
	kickAt?: number;
	frozen?: boolean;
	flying?: boolean;
	speedBoost?: boolean;
	invisible?: boolean;
}

interface RemotePlayer
{
	character: Character;
	vehicle?: THREE.Object3D;
	vehicleId?: string;
	vehicleCollision?: CANNON.Body;
	playerCollision?: CANNON.Body;
	animation?: string;
	color?: string;
	lastSeen: number;
	lastKickAt?: number;
	kickedVehicleId?: string;
	invisible?: boolean;
}

interface RemoteVehicle
{
	vehicle: Vehicle;
	collision: CANNON.Body;
}

export class OnlineMultiplayer
{
	private static readonly databaseUrl = 'https://texting-afd8b-default-rtdb.firebaseio.com';
	private static readonly roomName = 'sketchbook';
	private world: World;
	private database: any;
	private playerRef: any;
	private playersRef: any;
	private controlRef: any;
	private commandRef: any;
	private chatRef: any;
	private localCharacter: Character;
	private remotePlayers: { [id: string]: RemotePlayer } = {};
	private remoteVehicles: { [id: string]: RemoteVehicle } = {};
	private loadingManager: LoadingManager;
	private lastPublished = 0;
	private playerId: string;
	private lastLocalPosition = new THREE.Vector3();
	private lobbyId: string;
	private playerColor: string = '#2f80ed';
	private playerName: string = '';
	private isModerator: boolean = false;
	private freezeEveryone: boolean = false;
	private slowEveryone: boolean = false;
	private kickAt: number = 0;
	private lobbyMenu: HTMLElement;
	private moderatorMenu: HTMLElement;
	private chatPanel: HTMLElement;
	private centerCursor: HTMLElement;
	private currentTargetName: string = '';
	private modClones: Character[] = [];
	private modCloneIndex: number = -1;
	private cloneKeyHandler: ((e: KeyboardEvent) => void) | null = null;
	private bodyguards: Character[] = [];
	private bodyguardMarkers: THREE.Object3D[] = [];
	private bodyguardsEnabled: boolean = false;
	private bodyguardsRef: any;
	private remoteBodyguards: { [ownerId: string]: Character[] } = {};
	private remoteBodyguardCollisions: { [ownerId: string]: CANNON.Body[] } = {};
	private isInvisible: boolean = false;

	constructor(world: World, loadingManager: LoadingManager)
	{
		this.world = world;
		this.loadingManager = loadingManager;

		if (!firebase.apps.length)
		{
			firebase.initializeApp({ databaseURL: OnlineMultiplayer.databaseUrl });
		}

		this.database = firebase.database();
		this.createLobbyMenu();
		this.world.registerUpdatable(this);
	}

	public updateOrder: number = 4;

	public setLocalCharacter(character: Character): void
	{
		this.localCharacter = character;
		character.setPlayerColor(this.playerColor);
		character.setPlayerName(this.playerName || 'Player');
		if (this.isModerator) character.setModeratorSkin(true);
	}

	public update(timeStep: number): void
	{
		this.updateTargetCursor();
		this.updateBodyguards(timeStep);
		if (this.localCharacter === undefined || this.playerRef === undefined) return;

		const now = Date.now();
		if (now - this.lastPublished < 80) return;
		this.lastPublished = now;

		const occupiedSeat = this.localCharacter.occupyingSeat;
		const object: any = this.localCharacter.controlledObject || occupiedSeat?.vehicle || this.localCharacter;
		const position = object.collision === undefined ? object.position : object.collision.interpolatedPosition;
		const quaternion = object.collision === undefined ? object.quaternion : object.collision.interpolatedQuaternion;
		const vehicleType = object.userData.vehicleType || (object.entityType === 2 ? 'car' : object.entityType === 1 ? 'airplane' : object.entityType === 3 ? 'heli' : undefined);
		const vehicleId = vehicleType !== undefined ? String(object.userData.networkId || object.spawnPoint?.name || object.uuid) : undefined;
		const moving = vehicleType === undefined && position.distanceTo(this.lastLocalPosition) > 0.02;
		this.lastLocalPosition.copy(position);
		const state: OnlinePlayerState = {
			name: this.playerName,
			x: position.x,
			y: position.y,
			z: position.z,
			qx: quaternion.x,
			qy: quaternion.y,
			qz: quaternion.z,
			qw: quaternion.w,
			updatedAt: firebase.database.ServerValue.TIMESTAMP as any
		};
		if (vehicleType !== undefined) {
			state.vehicleType = vehicleType;
			state.vehicleId = vehicleId;
			state.seatName = occupiedSeat?.seatPointObject.name;
			state.kickAt = Number(object.kickAt || this.kickAt || 0);
		}
		else state.moving = moving;
		state.color = this.playerColor;
		state.moderator = this.isModerator;
		state.frozen = this.freezeEveryone && !this.isModerator;
		state.flying = this.localCharacter.isFlying;
		state.speedBoost = this.localCharacter.moveSpeed > 4;
		state.invisible = this.isInvisible;

		this.playerRef.set(state).catch((error) => console.error('Online multiplayer update failed', error));
		this.publishBodyguards();
	}

	private publishBodyguards(): void
	{
		if (this.bodyguardsRef === undefined || !this.isModerator) return;
		if (!this.bodyguardsEnabled || this.bodyguards.length === 0)
		{
			this.bodyguardsRef.set(null).catch(() => undefined);
			return;
		}
		const payload = this.bodyguards.map((guard) => ({
			x: guard.position.x,
			y: guard.position.y,
			z: guard.position.z,
			qx: guard.quaternion.x,
			qy: guard.quaternion.y,
			qz: guard.quaternion.z,
			qw: guard.quaternion.w
		}));
		this.bodyguardsRef.set(payload).catch(() => undefined);
	}

	private syncRemoteBodyguards(all: { [ownerId: string]: any }): void
	{
		const activeOwners: { [id: string]: boolean } = {};
		Object.keys(all || {}).forEach((ownerId) =>
		{
			if (ownerId === this.playerId) return;
			const list = all[ownerId];
			if (!list || !Array.isArray(list) || list.length === 0) return;
			activeOwners[ownerId] = true;

			if (this.remoteBodyguards[ownerId] === undefined)
			{
				this.remoteBodyguards[ownerId] = [];
				this.remoteBodyguardCollisions[ownerId] = [];
			}
			const guards = this.remoteBodyguards[ownerId];
			const colliders = this.remoteBodyguardCollisions[ownerId];

			list.forEach((state: any, i: number) =>
			{
				if (typeof state.x !== 'number') return;
				if (guards[i] === undefined)
				{
					this.loadingManager.loadGLTF('build/assets/boxman.glb', (model) =>
					{
						if (this.remoteBodyguards[ownerId] === undefined)
						{
							this.remoteBodyguards[ownerId] = [];
							this.remoteBodyguardCollisions[ownerId] = [];
						}
						if (this.remoteBodyguards[ownerId][i] !== undefined) return;
						const guard = new Character(model);
						guard.isRemote = true;
						guard.setPhysicsEnabled(false);
						guard.setModeratorSkin(true);
						guard.setPlayerName('Bodyguard');
						guard.setPlayerColor('#1a1a2e');
						guard.position.set(state.x, state.y, state.z);
						this.world.add(guard);
						this.remoteBodyguards[ownerId][i] = guard;
						const col = this.createRemotePlayerCollision();
						col.position.set(state.x, state.y + 0.5, state.z);
						this.remoteBodyguardCollisions[ownerId][i] = col;
					});
					return;
				}
				const guard = guards[i];
				guard.position.lerp(new THREE.Vector3(state.x, state.y, state.z), 0.35);
				if (typeof state.qx === 'number')
				{
					guard.quaternion.slerp(
						new THREE.Quaternion(state.qx, state.qy, state.qz, state.qw),
						0.35
					);
				}
				if (colliders[i] !== undefined)
				{
					colliders[i].position.set(guard.position.x, guard.position.y + 0.5, guard.position.z);
				}
			});

			while (guards.length > list.length)
			{
				const g = guards.pop();
				if (g !== undefined) this.world.remove(g);
				const c = colliders.pop();
				if (c !== undefined) this.world.physicsWorld.remove(c);
			}
		});

		Object.keys(this.remoteBodyguards).forEach((ownerId) =>
		{
			if (activeOwners[ownerId]) return;
			(this.remoteBodyguards[ownerId] || []).forEach((g) => this.world.remove(g));
			(this.remoteBodyguardCollisions[ownerId] || []).forEach((c) => this.world.physicsWorld.remove(c));
			delete this.remoteBodyguards[ownerId];
			delete this.remoteBodyguardCollisions[ownerId];
		});
	}

	private updateRemotePlayers(players: { [id: string]: OnlinePlayerState }): void
	{
		const activeIds: { [id: string]: boolean } = {};

		Object.keys(players).forEach((id) =>
		{
			if (id === this.playerId) return;

			const state = players[id];
			if (!state || typeof state.x !== 'number') return;

			activeIds[id] = true;
			let remote = this.remotePlayers[id];
			if (remote === undefined)
			{
				this.createRemotePlayer(id, state);
				return;
			}

			remote.lastSeen = Date.now();
			if (state.color !== undefined && remote.color !== state.color)
			{
				remote.color = state.color;
				remote.character.setPlayerColor(state.color);
			}
			const isRemoteMod = state.moderator === true;
			remote.character.isFrozen = this.freezeEveryone && !isRemoteMod;
			remote.character.isSlowed = this.slowEveryone && !isRemoteMod;
			remote.character.setPlayerName(state.name || 'Player');
			remote.character.userData.playerName = state.name || 'Player';
			remote.character.setModeratorSkin(isRemoteMod);
			remote.character.isFlying = state.flying === true;
			remote.character.moveSpeed = state.speedBoost === true ? 12 : 4;
			const inv = state.invisible === true;
			remote.invisible = inv;
			remote.character.visible = !inv;
			remote.character.traverse((child: any) =>
			{
				if (child.isSprite || child.isMesh) child.visible = !inv;
			});
			if (state.kickAt !== undefined && state.kickAt > (remote.lastKickAt || 0))
			{
				remote.lastKickAt = state.kickAt;
				if (this.localCharacter.occupyingSeat !== null && (this.localCharacter.occupyingSeat.vehicle as any).userData.networkId === state.vehicleId)
				{
					this.localCharacter.exitVehicle();
				}
				if (remote.character.parent !== this.world.graphicsWorld) this.world.graphicsWorld.attach(remote.character);
				remote.kickedVehicleId = state.vehicleId;
			}
			const position = new THREE.Vector3(state.x, state.y, state.z);
			const quaternion = new THREE.Quaternion(state.qx, state.qy, state.qz, state.qw);
			if (state.vehicleType !== undefined)
			{
				if (!inv) remote.character.visible = true;
				this.setRemoteAnimation(remote, 'driving');
				if (remote.kickedVehicleId === (state.vehicleId || id))
				{
					if (remote.character.parent !== this.world.graphicsWorld) this.world.graphicsWorld.attach(remote.character);
					remote.character.position.lerp(position, 0.35);
				}
				else this.syncRemoteVehicle(remote, state.vehicleId || id, state.vehicleType, state.seatName, position, quaternion);
				if (remote.vehicle !== undefined)
				{
					remote.vehicle.userData.fly = state.flying === true;
					remote.vehicle.userData.speedBoost = state.speedBoost === true;
				}
			}
			else
			{
				if (!inv) remote.character.visible = true;
				else remote.character.visible = false;
				this.removeRemoteVehicle(remote);
				if (remote.character.parent !== this.world.graphicsWorld) this.world.graphicsWorld.attach(remote.character);
				remote.character.position.lerp(position, 0.35);
				remote.character.quaternion.slerp(quaternion, 0.35);
				this.setRemoteAnimation(remote, state.moving === true ? 'run' : 'idle');
			}
			// Keep kinematic collider in sync so local player/cars bump into remotes
			this.syncRemotePlayerCollision(remote, position, inv);
		});

		Object.keys(this.remotePlayers).forEach((id) =>
		{
			if (!activeIds[id] || Date.now() - this.remotePlayers[id].lastSeen > 5000)
			{
				this.removeRemotePlayerCollision(this.remotePlayers[id]);
				this.world.remove(this.remotePlayers[id].character);
				this.removeRemoteVehicle(this.remotePlayers[id]);
				delete this.remotePlayers[id];
			}
		});
	}

	private createRemotePlayerCollision(): CANNON.Body
	{
		const body = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC });
		const shape = new CANNON.Sphere(0.55);
		body.addShape(shape);
		// Same group as vehicles so cars definitely collide
		body.collisionFilterGroup = 1;
		body.collisionFilterMask = -1;
		shape.collisionFilterGroup = 1;
		shape.collisionFilterMask = -1;
		this.world.physicsWorld.addBody(body);
		return body;
	}

	private syncRemotePlayerCollision(remote: RemotePlayer, position: THREE.Vector3, invisible: boolean): void
	{
		if (remote.playerCollision === undefined)
		{
			remote.playerCollision = this.createRemotePlayerCollision();
		}
		remote.playerCollision.position.set(position.x, position.y + 0.55, position.z);
		remote.playerCollision.velocity.setZero();
		// Arcade controller ignores most physics hits — push local player out of remote bodies
		this.separateLocalFromPoint(position.x, position.z, 0.95);
	}

	private separateLocalFromPoint(x: number, z: number, radius: number): void
	{
		if (this.localCharacter === undefined || this.localCharacter.characterCapsule === undefined) return;
		const body = this.localCharacter.characterCapsule.body;
		const dx = body.position.x - x;
		const dz = body.position.z - z;
		const dist = Math.sqrt(dx * dx + dz * dz);
		if (dist < radius && dist > 0.001)
		{
			const push = (radius - dist) * 0.7;
			const nx = dx / dist;
			const nz = dz / dist;
			body.position.x += nx * push;
			body.position.z += nz * push;
			body.interpolatedPosition.x = body.position.x;
			body.interpolatedPosition.z = body.position.z;
			this.localCharacter.position.x = body.position.x;
			this.localCharacter.position.z = body.position.z;
		}
	}

	private removeRemotePlayerCollision(remote: RemotePlayer): void
	{
		if (remote.playerCollision !== undefined)
		{
			this.world.physicsWorld.remove(remote.playerCollision);
			remote.playerCollision = undefined;
		}
	}

	private createRemotePlayer(id: string, state: OnlinePlayerState): void
	{
		this.loadingManager.loadGLTF('build/assets/boxman.glb', (model) =>
		{
			if (this.remotePlayers[id] !== undefined) return;

			const character = new Character(model);
			character.isRemote = true;
			character.setPhysicsEnabled(false);
			character.position.set(state.x, state.y, state.z);
			character.quaternion.set(state.qx, state.qy, state.qz, state.qw);
			this.world.add(character);
			if (state.color !== undefined) character.setPlayerColor(state.color);
			character.setPlayerName(state.name || 'Player');
			character.userData.playerName = state.name || 'Player';
			character.setModeratorSkin(state.moderator === true);
			const inv = state.invisible === true;
			character.visible = !inv;
			const remote: RemotePlayer = {
				character,
				color: state.color,
				lastSeen: Date.now(),
				invisible: inv,
				playerCollision: this.createRemotePlayerCollision()
			};
			remote.playerCollision.position.set(state.x, state.y + 0.5, state.z);
			this.remotePlayers[id] = remote;
			this.setRemoteAnimation(remote, state.vehicleType !== undefined ? 'driving' : state.moving === true ? 'run' : 'idle');
		});
	}

	private syncRemoteVehicle(remote: RemotePlayer, vehicleId: string, vehicleType: string, seatName: string, position: THREE.Vector3, quaternion: THREE.Quaternion): void
	{
		if (remote.vehicleId !== undefined && remote.vehicleId !== vehicleId) this.removeRemoteVehicle(remote);
		const existing = this.remoteVehicles[vehicleId];
		if (existing !== undefined)
		{
			remote.vehicleId = vehicleId;
			remote.vehicle = existing.vehicle;
			this.attachRemoteCharacter(remote, seatName);
			existing.vehicle.position.lerp(position, 0.35);
			existing.vehicle.quaternion.slerp(quaternion, 0.35);
			return;
		}

		if (remote.vehicle === undefined || remote.vehicle.userData.vehicleType !== vehicleType)
		{
			this.removeRemoteVehicle(remote);
			const assetType = vehicleType === 'pickup' ? 'car' : vehicleType;
			this.loadingManager.loadGLTF('build/assets/' + assetType + '.glb', (model) =>
			{
				if (this.remoteVehicles[vehicleId] !== undefined) return;
				const vehicle = this.createVehicleVisual(vehicleType, model);
				vehicle.userData.vehicleType = vehicleType;
				vehicle.position.copy(position);
				vehicle.quaternion.copy(quaternion);
				this.world.graphicsWorld.add(vehicle);
				remote.vehicle = vehicle;
				this.attachRemoteCharacter(remote);
				const collision = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC });
				collision.addShape(new CANNON.Box(new CANNON.Vec3(1.2, 0.6, 2.2)));
				this.world.physicsWorld.addBody(collision);
				this.remoteVehicles[vehicleId] = { vehicle, collision };
				remote.vehicleId = vehicleId;
				remote.vehicleCollision = collision;
				this.attachRemoteCharacter(remote, seatName);
			});
			return;
		}

		remote.vehicle.position.lerp(position, 0.35);
		remote.vehicle.quaternion.slerp(quaternion, 0.35);
		if (remote.vehicleCollision !== undefined)
		{
			remote.vehicleCollision.position.set(remote.vehicle.position.x, remote.vehicle.position.y, remote.vehicle.position.z);
			remote.vehicleCollision.quaternion.set(remote.vehicle.quaternion.x, remote.vehicle.quaternion.y, remote.vehicle.quaternion.z, remote.vehicle.quaternion.w);
		}
	}

	private setRemoteAnimation(remote: RemotePlayer, animation: string): void
	{
		if (remote.animation === animation) return;
		remote.animation = animation;
		remote.character.setAnimation(animation, 0.1);
	}

	private removeRemoteVehicle(remote: RemotePlayer): void
	{
		const vehicleId = remote.vehicleId;
		const shared = vehicleId === undefined ? undefined : this.remoteVehicles[vehicleId];
		const stillUsed = vehicleId !== undefined && Object.keys(this.remotePlayers).some((id) =>
			id !== this.playerId && this.remotePlayers[id] !== remote && this.remotePlayers[id].vehicleId === vehicleId);
		if (remote.vehicle !== undefined)
		{
			if (remote.character.parent === remote.vehicle) this.world.graphicsWorld.attach(remote.character);
			if (!stillUsed) this.world.graphicsWorld.remove(remote.vehicle);
			remote.vehicle = undefined;
		}
		if (vehicleId !== undefined)
		{
			if (shared !== undefined)
			{
				if (!stillUsed)
				{
					this.world.graphicsWorld.remove(shared.vehicle);
					this.world.physicsWorld.remove(shared.collision);
					delete this.remoteVehicles[vehicleId];
				}
			}
			remote.vehicleId = undefined;
		}
		if (remote.vehicleCollision !== undefined)
		{
			this.world.physicsWorld.remove(remote.vehicleCollision);
			remote.vehicleCollision = undefined;
		}
	}

	private attachRemoteCharacter(remote: RemotePlayer, seatName?: string): void
	{
		if (remote.vehicle === undefined || remote.character.parent === remote.vehicle) return;
		remote.vehicle.add(remote.character);
		const seat = remote.vehicle instanceof Vehicle ? remote.vehicle.seats.find((candidate) => candidate.seatPointObject.name === seatName) || remote.vehicle.seats[0] : undefined;
		if (seat !== undefined)
		{
			remote.character.position.copy(seat.seatPointObject.position);
			remote.character.position.y += 0.6;
		}
		else remote.character.position.set(0, 0.7, 0);
		remote.character.quaternion.set(0, 0, 0, 1);
	}

	private createVehicleVisual(vehicleType: string, model: any): Vehicle
	{
		switch (vehicleType)
		{
			case 'car': return new Car(model);
			case 'pickup': return new PickupTruck(model);
			case 'airplane': return new Airplane(model);
			case 'heli': return new Helicopter(model);
			default: return new Car(model);
		}
	}

	private createLobbyMenu(): void
	{
		const menu = document.createElement('div');
		menu.id = 'lobby-menu';
		menu.innerHTML = '<div class="lobby-panel">' +
			'<h1>Sketchbook 1.0</h1>' +
			'<label for="lobby-name">Lobby</label>' +
			'<input id="lobby-name" value="main" maxlength="24" />' +
			'<label for="player-name">Username</label>' +
			'<input id="player-name" maxlength="32" placeholder="Choose a username" />' +
			'<div id="lobby-list"></div>' +
			'<label>Player color</label>' +
			'<div class="color-list">' +
				'<button class="player-color" data-color="#2f80ed" style="background:#2f80ed"></button>' +
				'<button class="player-color" data-color="#e74c3c" style="background:#e74c3c"></button>' +
				'<button class="player-color" data-color="#27ae60" style="background:#27ae60"></button>' +
				'<button class="player-color" data-color="#f1c40f" style="background:#f1c40f"></button>' +
				'<button class="player-color" data-color="#9b59b6" style="background:#9b59b6"></button>' +
			'</div>' +
			'<button id="join-lobby">Join lobby</button>' +
			'<div id="lobby-status"></div>' +
		'</div>';
		document.body.appendChild(menu);
		this.lobbyMenu = menu;
		this.createModeratorMenu();
		this.createChat();

		const lobbyList = this.database.ref(OnlineMultiplayer.roomName + '/lobbies');
		lobbyList.on('value', (snapshot) =>
		{
			const names = Object.keys(snapshot.val() || {});
			const list = document.getElementById('lobby-list');
			list.innerHTML = names.length ? 'Open: ' + names.join(', ') : 'No open lobbies yet';
		});

		menu.querySelectorAll('.player-color').forEach((button: HTMLElement) =>
		{
			button.onclick = () =>
			{
				this.playerColor = button.getAttribute('data-color');
				if (this.localCharacter !== undefined) this.localCharacter.setPlayerColor(this.playerColor);
				menu.querySelectorAll('.player-color').forEach((item: HTMLElement) => item.classList.remove('selected'));
				button.classList.add('selected');
			};
		});
		(menu.querySelector('.player-color') as HTMLElement).classList.add('selected');
		const nameInput = document.getElementById('player-name') as HTMLInputElement;
		nameInput.oninput = () =>
		{
			this.moderatorMenu.style.display = nameInput.value.trim().toLowerCase() === 'charles cheatham 67' ? 'block' : 'none';
		};
		(document.getElementById('join-lobby') as HTMLElement).onclick = () => this.joinLobby();
	}

	private createModeratorMenu(): void
	{
		const menu = document.createElement('div');
		menu.id = 'moderator-menu';
		menu.innerHTML = '<div class="moderator-panel">' +
			'<strong>Moderator</strong>' +
			'<button id="mod-fly">Fly</button>' +
			'<button id="mod-invisible">Invisible</button>' +
			'<button id="mod-speed">Speed boost</button>' +
			'<button id="mod-freeze">Freeze everyone</button>' +
			'<button id="mod-slow">Slow everyone</button>' +
			'<button id="mod-kickvehicles">Kick all from vehicles</button>' +
			'<button id="mod-clone">Clone (G)</button>' +
			'<button id="mod-switchclone">Switch clone (Shift+G)</button>' +
			'<button id="mod-clearclones">Clear clones (P)</button>' +
			'<button id="mod-bodyguards">Bodyguards</button>' +
			'<button id="mod-heal">Reset velocity</button>' +
			'</div>';
		document.body.appendChild(menu);
		this.moderatorMenu = menu;
		this.centerCursor = document.createElement('div');
		this.centerCursor.id = 'moderator-cursor';
		document.body.appendChild(this.centerCursor);

		const bind = (id: string, fn: () => void) =>
		{
			const el = document.getElementById(id);
			if (el) el.onclick = fn;
		};

		bind('mod-freeze', () =>
		{
			this.freezeEveryone = !this.freezeEveryone;
			if (this.localCharacter !== undefined) this.localCharacter.isFrozen = false;
			Object.keys(this.remotePlayers).forEach((id) =>
			{
				const remote = this.remotePlayers[id];
				remote.character.isFrozen = this.freezeEveryone && !(remote.character as any).moderatorSkinEnabled;
			});
			if (this.controlRef !== undefined) this.controlRef.update({ freeze: this.freezeEveryone, slow: this.slowEveryone });
		});
		bind('mod-slow', () =>
		{
			this.slowEveryone = !this.slowEveryone;
			if (this.localCharacter !== undefined) this.localCharacter.isSlowed = false;
			Object.keys(this.remotePlayers).forEach((id) =>
			{
				const remote = this.remotePlayers[id];
				remote.character.isSlowed = this.slowEveryone && !(remote.character as any).moderatorSkinEnabled;
			});
			if (this.controlRef !== undefined) this.controlRef.update({ freeze: this.freezeEveryone, slow: this.slowEveryone });
		});
		bind('mod-fly', () =>
		{
			if (this.localCharacter === undefined) return;
			this.localCharacter.isFlying = !this.localCharacter.isFlying;
			if (this.localCharacter.occupyingSeat !== null)
			{
				(this.localCharacter.occupyingSeat.vehicle as any).userData.fly = this.localCharacter.isFlying;
			}
		});
		bind('mod-speed', () =>
		{
			if (this.localCharacter === undefined) return;
			this.localCharacter.moveSpeed = this.localCharacter.moveSpeed === 12 ? 4 : 12;
			if (this.localCharacter.occupyingSeat !== null)
			{
				(this.localCharacter.occupyingSeat.vehicle as any).userData.speedBoost = this.localCharacter.moveSpeed > 4;
			}
		});
		bind('mod-invisible', () =>
		{
			if (this.localCharacter === undefined) return;
			this.isInvisible = !this.isInvisible;
			this.localCharacter.visible = !this.isInvisible;
			this.localCharacter.traverse((child: any) =>
			{
				if (child.isSprite) child.visible = !this.isInvisible;
			});
		});
		bind('mod-kickvehicles', () =>
		{
			Object.keys(this.remotePlayers).forEach((id) =>
			{
				const remote = this.remotePlayers[id];
				const target = (remote.character.userData.playerName as string) || 'Player';
				this.commandRef?.push({
					command: 'exitvehicle',
					target,
					at: firebase.database.ServerValue.TIMESTAMP
				});
			});
		});
		bind('mod-clone', () => this.spawnModeratorClone());
		bind('mod-switchclone', () => this.switchModeratorClone());
		bind('mod-clearclones', () => this.removeAllModeratorClones());
		bind('mod-heal', () =>
		{
			if (this.localCharacter === undefined) return;
			const body = this.localCharacter.characterCapsule?.body;
			if (body !== undefined) body.velocity.set(0, 0, 0);
			this.localCharacter.isFrozen = false;
			this.localCharacter.isSlowed = false;
		});
		bind('mod-bodyguards', () => this.toggleBodyguards());
	}

	private createChat(): void
	{
		this.chatPanel = document.createElement('div');
		this.chatPanel.id = 'chat-panel';
		this.chatPanel.innerHTML = '<div id="chat-messages"></div><input id="chat-input" maxlength="120" placeholder="Chat" />';
		document.body.appendChild(this.chatPanel);
		const input = document.getElementById('chat-input') as HTMLInputElement;
		input.onkeydown = (event: KeyboardEvent) =>
		{
			if (event.code !== 'Enter' || input.value.trim() === '') return;
			const text = input.value.trim();
			input.value = '';
			const commandText = text[0] === '!' ? text.slice(1) : text;
			if (this.isModerator && /^(freeze|fly|superspeed|slow)(?:\s+.*)?$/i.test(commandText)) this.sendCommand(commandText);
			else this.chatRef?.push({ name: this.playerName || 'Player', text, at: firebase.database.ServerValue.TIMESTAMP });
		};
	}

	private sendCommand(commandText: string): void
	{
		const parts = commandText.trim().split(/\s+/);
		const command = parts.shift()?.toLowerCase();
		const target = parts.join(' ') || this.currentTargetName;
		if (command !== 'freeze' && command !== 'fly' && command !== 'superspeed' && command !== 'slow') return;
		if (target === '') return;
		this.commandRef?.push({ command, target, at: firebase.database.ServerValue.TIMESTAMP });
		this.chatRef?.push({ name: 'Moderator', text: '!' + command + ' ' + target, at: firebase.database.ServerValue.TIMESTAMP });
	}

	private applyCommand(command: string, target: string): void
	{
		if (target.toLowerCase() !== this.playerName.toLowerCase() || this.localCharacter === undefined) return;
		if (command === 'freeze') this.localCharacter.isFrozen = !this.localCharacter.isFrozen;
		if (command === 'slow') this.localCharacter.isSlowed = !this.localCharacter.isSlowed;
		if (command === 'fly')
		{
			this.localCharacter.isFlying = !this.localCharacter.isFlying;
			if (this.localCharacter.occupyingSeat !== null) (this.localCharacter.occupyingSeat.vehicle as any).userData.fly = this.localCharacter.isFlying;
		}
		if (command === 'superspeed')
		{
			this.localCharacter.moveSpeed = this.localCharacter.moveSpeed === 12 ? 4 : 12;
			if (this.localCharacter.occupyingSeat !== null) (this.localCharacter.occupyingSeat.vehicle as any).userData.speedBoost = this.localCharacter.moveSpeed > 4;
		}
		if (command === 'exitvehicle' && this.localCharacter.occupyingSeat !== null)
		{
			this.localCharacter.exitVehicle();
		}
	}

	private updateTargetCursor(): void
	{
		if (!this.isModerator || this.localCharacter === undefined) return;
		const candidates: Array<{ name: string; object: THREE.Object3D; distance: number }> = [];
		Object.keys(this.remotePlayers).forEach((id) =>
		{
			const remote = this.remotePlayers[id];
			const targetName = remote.character.userData.playerName || 'Player';
			const objects = remote.vehicle === undefined ? [remote.character] : [remote.vehicle, remote.character];
			objects.forEach((object) =>
			{
				const projected = object.position.clone().project(this.world.camera);
				if (projected.z > -1 && projected.z < 1) candidates.push({ name: targetName, object, distance: Math.sqrt(projected.x * projected.x + projected.y * projected.y) });
			});
		});
		candidates.sort((a, b) => a.distance - b.distance);
		this.currentTargetName = candidates.length > 0 && candidates[0].distance < 0.18 ? candidates[0].name : '';
		this.centerCursor.classList.toggle('targeting', this.currentTargetName !== '');
	}

	private joinLobby(): void
	{
		const input = document.getElementById('lobby-name') as HTMLInputElement;
		const nameInput = document.getElementById('player-name') as HTMLInputElement;
		this.playerName = (nameInput.value || 'Player').trim().replace(/\s+/g, ' ').slice(0, 32) || 'Player';
		this.isModerator = this.playerName.toLowerCase() === 'charles cheatham 67';
		if (this.localCharacter !== undefined) this.localCharacter.setPlayerName(this.playerName);
		if (this.localCharacter !== undefined) this.localCharacter.setModeratorSkin(this.isModerator);
		this.lobbyId = (input.value || 'main').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 24) || 'main';
		this.playerId = this.database.ref().push().key;
		const lobbyRef = this.database.ref(OnlineMultiplayer.roomName + '/lobbies/' + this.lobbyId);
		this.controlRef = lobbyRef.child('control');
		this.commandRef = lobbyRef.child('commands');
		this.chatRef = lobbyRef.child('chat');
		this.playersRef = lobbyRef.child('players');
		this.playerRef = this.playersRef.child(this.playerId);
		this.playerRef.onDisconnect().remove();
		this.bodyguardsRef = lobbyRef.child('bodyguards').child(this.playerId);
		this.bodyguardsRef.onDisconnect().remove();
		lobbyRef.child('bodyguards').on('value', (snapshot) => this.syncRemoteBodyguards(snapshot.val() || {}));
		this.playersRef.on('value', (snapshot) => this.updateRemotePlayers(snapshot.val() || {}));
		this.controlRef.on('value', (snapshot) =>
		{
			const data = snapshot.val() || {};
			this.freezeEveryone = data.freeze === true;
			this.slowEveryone = data.slow === true;
			// Never freeze or slow the local moderator
			if (this.localCharacter !== undefined)
			{
				this.localCharacter.isFrozen = this.freezeEveryone && !this.isModerator;
				this.localCharacter.isSlowed = this.slowEveryone && !this.isModerator;
			}
			Object.keys(this.remotePlayers).forEach((id) =>
			{
				const remote = this.remotePlayers[id];
				const isMod = (remote.character as any).moderatorSkinEnabled === true;
				remote.character.isFrozen = this.freezeEveryone && !isMod;
				remote.character.isSlowed = this.slowEveryone && !isMod;
			});
		});
		this.commandRef.on('child_added', (snapshot) =>
		{
			const command = snapshot.val();
			if (command?.command && command?.target) this.applyCommand(command.command, command.target);
		});
		this.chatRef.on('value', (snapshot) =>
		{
			const values = snapshot.val() || {};
			const messages = Object.keys(values).map((key) => values[key]).slice(-12) as any[];
			const container = document.getElementById('chat-messages');
			container.innerHTML = messages.map((message) => '<div><strong>' + message.name + ':</strong> ' + message.text + '</div>').join('');
			container.scrollTop = container.scrollHeight;
		});
		lobbyRef.child('lastActive').set(firebase.database.ServerValue.TIMESTAMP);
		this.lobbyMenu.style.display = 'none';
		this.moderatorMenu.style.display = this.isModerator ? 'block' : 'none';
		this.centerCursor.style.display = this.isModerator ? 'block' : 'none';
		if (this.isModerator) this.bindModeratorCloneKeys();
	}

	private bindModeratorCloneKeys(): void
	{
		if (this.cloneKeyHandler) return;
		this.cloneKeyHandler = (event: KeyboardEvent) =>
		{
			if (!this.isModerator || this.localCharacter === undefined) return;
			// Ignore when typing in chat
			const tag = (event.target as HTMLElement)?.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA') return;

			if (event.code === 'KeyG' && event.type === 'keydown')
			{
				event.preventDefault();
				if (event.shiftKey) this.switchModeratorClone();
				else this.spawnModeratorClone();
			}
			if (event.code === 'KeyP' && event.type === 'keydown')
			{
				event.preventDefault();
				this.removeAllModeratorClones();
			}
		};
		window.addEventListener('keydown', this.cloneKeyHandler);
	}

	private spawnModeratorClone(): void
	{
		if (this.localCharacter === undefined) return;
		if (this.modClones.length >= 8) return; // soft limit

		this.loadingManager.loadGLTF('build/assets/boxman.glb', (model) =>
		{
			const clone = new Character(model);
			clone.isRemote = true;
			clone.setPhysicsEnabled(false);
			clone.setModeratorSkin(true);
			clone.setPlayerName((this.playerName || 'Mod') + ' clone');
			clone.setPlayerColor(this.playerColor);

			const pos = this.localCharacter.position.clone();
			const quat = this.localCharacter.quaternion.clone();
			clone.position.copy(pos);
			clone.quaternion.copy(quat);
			clone.setAnimation('idle', 0.1);

			this.world.add(clone);
			this.modClones.push(clone);
			this.modCloneIndex = this.modClones.length - 1;
		});
	}

	private switchModeratorClone(): void
	{
		if (this.localCharacter === undefined || this.modClones.length === 0) return;

		// Leave a body at current position
		const currentPos = this.localCharacter.position.clone();
		const currentQuat = this.localCharacter.quaternion.clone();

		this.modCloneIndex = (this.modCloneIndex + 1) % this.modClones.length;
		const target = this.modClones[this.modCloneIndex];
		if (target === undefined) return;

		const targetPos = target.position.clone();
		const targetQuat = target.quaternion.clone();

		// Swap: target clone takes old player pos, player takes clone pos
		target.position.copy(currentPos);
		target.quaternion.copy(currentQuat);

		if (this.localCharacter.characterCapsule !== undefined)
		{
			this.localCharacter.characterCapsule.body.position.set(targetPos.x, targetPos.y, targetPos.z);
			this.localCharacter.characterCapsule.body.interpolatedPosition.set(targetPos.x, targetPos.y, targetPos.z);
			this.localCharacter.characterCapsule.body.velocity.set(0, 0, 0);
		}
		this.localCharacter.position.copy(targetPos);
		this.localCharacter.quaternion.copy(targetQuat);
	}

	private removeAllModeratorClones(): void
	{
		this.modClones.forEach((clone) =>
		{
			this.world.remove(clone);
		});
		this.modClones = [];
		this.modCloneIndex = -1;
	}

	private toggleBodyguards(): void
	{
		if (this.bodyguardsEnabled)
		{
			this.clearBodyguards();
			this.bodyguardsEnabled = false;
			return;
		}
		this.bodyguardsEnabled = true;
		this.spawnBodyguards(12);
	}

	private spawnBodyguards(count: number): void
	{
		this.clearBodyguards();
		if (this.localCharacter === undefined) return;

		const origin = this.localCharacter.position.clone();
		const radius = 2.8;

		for (let i = 0; i < count; i++)
		{
			// Each guard gets a fixed angle on the circle
			const angle = (i / count) * Math.PI * 2;
			const marker = new THREE.Object3D();
			marker.position.set(
				origin.x + Math.cos(angle) * radius,
				origin.y,
				origin.z + Math.sin(angle) * radius
			);
			this.world.graphicsWorld.add(marker);
			this.bodyguardMarkers.push(marker);

			const index = i;
			this.loadingManager.loadGLTF('build/assets/boxman.glb', (model) =>
			{
				if (!this.bodyguardsEnabled || this.localCharacter === undefined) return;

				const guard = new Character(model);
				guard.setModeratorSkin(true);
				guard.setPlayerName('Bodyguard');
				guard.setPlayerColor('#1a1a2e');

				// Spawn near the player; they walk out to their circle slot
				guard.setPosition(
					origin.x + (Math.random() - 0.5) * 1.5,
					origin.y + 0.5,
					origin.z + (Math.random() - 0.5) * 1.5
				);

				const target = this.bodyguardMarkers[index];
				if (target === undefined) return;
				guard.userData.bodyguardMarker = target;
				guard.setBehaviour(new FollowTarget(target, 1.0));
				this.world.add(guard);
				this.bodyguards.push(guard);
			});
		}
	}

	private clearBodyguards(): void
	{
		this.bodyguards.forEach((guard) => this.world.remove(guard));
		this.bodyguards = [];
		this.bodyguardMarkers.forEach((m) => this.world.graphicsWorld.remove(m));
		this.bodyguardMarkers = [];
	}

	private updateBodyguards(timeStep: number): void
	{
		if (!this.bodyguardsEnabled || this.localCharacter === undefined) return;
		if (this.bodyguardMarkers.length === 0) return;

		// Keep circle slots around the moderator (height follows when you fly)
		const radius = 2.8;
		const cx = this.localCharacter.position.x;
		const cy = this.localCharacter.position.y;
		const cz = this.localCharacter.position.z;
		const n = this.bodyguardMarkers.length;
		const flying = this.localCharacter.isFlying === true;

		this.bodyguardMarkers.forEach((marker, i) =>
		{
			const angle = (i / n) * Math.PI * 2;
			marker.position.set(
				cx + Math.cos(angle) * radius,
				cy,
				cz + Math.sin(angle) * radius
			);
		});

		this.bodyguards.forEach((guard) =>
		{
			guard.isFlying = flying;
			const marker = guard.userData.bodyguardMarker as THREE.Object3D;

			if (flying && guard.characterCapsule !== undefined && marker !== undefined)
			{
				// Fly with you in formation — smooth follow, no gravity fling
				const body = guard.characterCapsule.body;
				const t = marker.position;
				const blend = Math.min(1, 12 * timeStep);
				body.position.x += (t.x - body.position.x) * blend;
				body.position.y += (t.y - body.position.y) * blend;
				body.position.z += (t.z - body.position.z) * blend;
				body.interpolatedPosition.copy(body.position);
				body.velocity.set(0, 0, 0);
				body.angularVelocity.set(0, 0, 0);
				body.force.set(0, 0, 0);
				guard.position.set(body.position.x, body.position.y, body.position.z);
				guard.triggerAction('up', false);
				guard.setAnimation('idle', 0.1);
			}
		});
	}
}