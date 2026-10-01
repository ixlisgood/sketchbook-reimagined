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
}

interface RemotePlayer
{
	character: Character;
	vehicle?: THREE.Object3D;
	vehicleId?: string;
	vehicleCollision?: CANNON.Body;
	animation?: string;
	color?: string;
	lastSeen: number;
	lastKickAt?: number;
	kickedVehicleId?: string;
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

		this.playerRef.set(state).catch((error) => console.error('Online multiplayer update failed', error));
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
				remote.character.visible = true;
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
				remote.character.visible = true;
				this.removeRemoteVehicle(remote);
				if (remote.character.parent !== this.world.graphicsWorld) this.world.graphicsWorld.attach(remote.character);
				remote.character.position.lerp(position, 0.35);
				remote.character.quaternion.slerp(quaternion, 0.35);
				this.setRemoteAnimation(remote, state.moving === true ? 'run' : 'idle');
			}
		});

		Object.keys(this.remotePlayers).forEach((id) =>
		{
			if (!activeIds[id] || Date.now() - this.remotePlayers[id].lastSeen > 5000)
			{
				this.world.remove(this.remotePlayers[id].character);
				this.removeRemoteVehicle(this.remotePlayers[id]);
				delete this.remotePlayers[id];
			}
		});
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
			this.remotePlayers[id] = { character, color: state.color, lastSeen: Date.now() };
			this.setRemoteAnimation(this.remotePlayers[id], state.vehicleType !== undefined ? 'driving' : state.moving === true ? 'run' : 'idle');
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
		menu.innerHTML = '<div class="moderator-panel"><strong>Moderator</strong>' +
			'<button id="mod-fly">Fly</button>' +
			'<button id="mod-freeze">Freeze everyone</button>' +
			'<button id="mod-slow">Slow everyone</button>' +
			'<button id="mod-speed">Speed boost</button></div>';
		document.body.appendChild(menu);
		this.moderatorMenu = menu;
		this.centerCursor = document.createElement('div');
		this.centerCursor.id = 'moderator-cursor';
		document.body.appendChild(this.centerCursor);
		(document.getElementById('mod-freeze') as HTMLElement).onclick = () =>
		{
			this.freezeEveryone = !this.freezeEveryone;
			// Freeze never affects the moderator
			if (this.localCharacter !== undefined) this.localCharacter.isFrozen = false;
			Object.keys(this.remotePlayers).forEach((id) =>
			{
				const remote = this.remotePlayers[id];
				remote.character.isFrozen = this.freezeEveryone && !(remote.character as any).moderatorSkinEnabled;
			});
			if (this.controlRef !== undefined) this.controlRef.update({ freeze: this.freezeEveryone, slow: this.slowEveryone });
		};
		(document.getElementById('mod-slow') as HTMLElement).onclick = () =>
		{
			this.slowEveryone = !this.slowEveryone;
			if (this.localCharacter !== undefined) this.localCharacter.isSlowed = false;
			Object.keys(this.remotePlayers).forEach((id) =>
			{
				const remote = this.remotePlayers[id];
				remote.character.isSlowed = this.slowEveryone && !(remote.character as any).moderatorSkinEnabled;
			});
			if (this.controlRef !== undefined) this.controlRef.update({ freeze: this.freezeEveryone, slow: this.slowEveryone });
		};
		(document.getElementById('mod-fly') as HTMLElement).onclick = () =>
		{
			if (this.localCharacter !== undefined)
			{
				this.localCharacter.isFlying = !this.localCharacter.isFlying;
				if (this.localCharacter.occupyingSeat !== null)
				{
					(this.localCharacter.occupyingSeat.vehicle as any).userData.fly = this.localCharacter.isFlying;
				}
			}
		};
		(document.getElementById('mod-speed') as HTMLElement).onclick = () =>
		{
			if (this.localCharacter !== undefined)
			{
				this.localCharacter.moveSpeed = this.localCharacter.moveSpeed === 12 ? 4 : 12;
				if (this.localCharacter.occupyingSeat !== null)
				{
					(this.localCharacter.occupyingSeat.vehicle as any).userData.speedBoost = this.localCharacter.moveSpeed > 4;
				}
			}
		};
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
		// Targeted freeze/slow still apply (moderator can target self if desired, but global ones skip mod)
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
	}
}