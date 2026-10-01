import { Vehicle } from './Vehicle';
import { IControllable } from '../interfaces/IControllable';
import { EntityType } from '../enums/EntityType';
export declare class Mech extends Vehicle implements IControllable {
    entityType: EntityType;
    private grabbedBody;
    constructor(gltf: any);
    private static scaleModel;
    noDirectionPressed(): boolean;
    update(timeStep: number): void;
    onInputChange(): void;
    private toggleGrab;
    private throwGrabbed;
}
