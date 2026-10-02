import { Car } from './Car';
import { EntityType } from '../enums/EntityType';
import { IControllable } from '../interfaces/IControllable';
export declare class Mech extends Car implements IControllable {
    entityType: EntityType;
    private heldBody;
    private pickupRange;
    constructor(gltf: any);
    update(timeStep: number): void;
    onInputChange(): void;
    inputReceiverInit(): void;
    private tryPickup;
}
