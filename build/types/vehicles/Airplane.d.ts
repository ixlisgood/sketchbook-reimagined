import * as CANNON from 'cannon';
import { Vehicle } from './Vehicle';
import { IControllable } from '../interfaces/IControllable';
import { IWorldEntity } from '../interfaces/IWorldEntity';
import { EntityType } from '../enums/EntityType';
export declare class Airplane extends Vehicle implements IControllable, IWorldEntity {
    entityType: EntityType;
    private steeringSimulator;
    private enginePower;
    private lastDrag;
    constructor(gltf: any);
    /** Custom F-16 mesh has no sketchbook rotor/seat/collision rig — add defaults. */
    private ensureJetSetup;
    noDirectionPressed(): boolean;
    update(timeStep: number): void;
    physicsPreStep(body: CANNON.Body, plane: Airplane): void;
    onInputChange(): void;
    inputReceiverInit(): void;
}
