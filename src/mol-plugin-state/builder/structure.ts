/**
 * Copyright (c) 2020 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author David Sehnal <david.sehnal@gmail.com>
 */

import { PluginContext } from '../../mol-plugin/context';
import { StateObjectRef, StateObjectSelector, StateTransformer, StateTransform, StateObjectCell } from '../../mol-state';
import { PluginStateObject as SO } from '../objects';
import { StateTransforms } from '../transforms';
import { RootStructureDefinition } from '../helpers/root-structure';
import { StructureComponentParams, StaticStructureComponentType } from '../helpers/structure-component';
import { BuiltInTrajectoryFormat, TrajectoryFormatProvider } from '../formats/trajectory';
import { StructureRepresentationBuilder } from './structure/representation';
import { StructureSelectionQuery } from '../helpers/structure-selection-query';
import { Task } from '../../mol-task';
import { StructureElement } from '../../mol-model/structure';
import { ModelSymmetry } from '../../mol-model-formats/structure/property/symmetry';
import { SpacegroupCell } from '../../mol-math/geometry';
import Expression from '../../mol-script/language/expression';

export type TrajectoryFormat = 'pdb' | 'cif' | 'gro' | '3dg'

export enum StructureBuilderTags {
    // TODO: this tag might be redundant
    Component = 'structure-component'
}

export class StructureBuilder {
    private get dataState() {
        return this.plugin.state.data;
    }

    private async parseTrajectoryData(data: StateObjectRef<SO.Data.Binary | SO.Data.String>, format: BuiltInTrajectoryFormat | TrajectoryFormatProvider) {
        const provider = typeof format === 'string' ? this.plugin.dataFormat.trajectory.get(format) : format;
        if (!provider) throw new Error(`'${format}' is not a supported data format.`);
        const { trajectory } = await provider.parse(this.plugin, data);
        return trajectory;
    }

    private async parseTrajectoryBlob(data: StateObjectRef<SO.Data.Blob>, params: StateTransformer.Params<StateTransforms['Data']['ParseBlob']>) {
        const state = this.dataState;
        const trajectory = state.build().to(data)
            .apply(StateTransforms.Data.ParseBlob, params, { state: { isGhost: true } })
            .apply(StateTransforms.Model.TrajectoryFromBlob, void 0);
        await this.plugin.updateDataState(trajectory, { revertOnError: true });
        return trajectory.selector;
    }

    readonly representation = new StructureRepresentationBuilder(this.plugin);

    async parseTrajectory(data: StateObjectRef<SO.Data.Binary | SO.Data.String>, format: BuiltInTrajectoryFormat | TrajectoryFormatProvider): Promise<StateObjectSelector<SO.Molecule.Trajectory>>
    async parseTrajectory(blob: StateObjectRef<SO.Data.Blob>, params: StateTransformer.Params<StateTransforms['Data']['ParseBlob']>): Promise<StateObjectSelector<SO.Molecule.Trajectory>>
    async parseTrajectory(data: StateObjectRef, params: any) {
        const cell = StateObjectRef.resolveAndCheck(this.dataState, data as StateObjectRef);
        if (!cell) throw new Error('Invalid data cell.');

        if (SO.Data.Blob.is(cell.obj)) {
            return this.parseTrajectoryBlob(data, params);
        } else {
            return this.parseTrajectoryData(data, params);
        }
    }

    async createModel(trajectory: StateObjectRef<SO.Molecule.Trajectory>, params?: StateTransformer.Params<StateTransforms['Model']['ModelFromTrajectory']>, initialState?: Partial<StateTransform.State>) {
        const state = this.dataState;
        const model = state.build().to(trajectory)
            .apply(StateTransforms.Model.ModelFromTrajectory, params || { modelIndex: 0 }, { state: initialState });

        await this.plugin.updateDataState(model, { revertOnError: true });
        return model.selector;
    }

    async insertModelProperties(model: StateObjectRef<SO.Molecule.Model>, params?: StateTransformer.Params<StateTransforms['Model']['CustomModelProperties']>) {
        const state = this.dataState;
        const props = state.build().to(model)
            .apply(StateTransforms.Model.CustomModelProperties, params);
        await this.plugin.updateDataState(props, { revertOnError: true });
        return props.selector;
    }

    async tryCreateUnitcell(model: StateObjectRef<SO.Molecule.Model>, params?: StateTransformer.Params<StateTransforms['Representation']['ModelUnitcell3D']>, initialState?: Partial<StateTransform.State>) {
        const state = this.dataState;
        const m = StateObjectRef.resolveAndCheck(state, model)?.obj?.data;
        if (!m) return;
        const cell = ModelSymmetry.Provider.get(m)?.spacegroup.cell;
        if (SpacegroupCell.isZero(cell)) return;

        const unitcell = state.build().to(model)
            .apply(StateTransforms.Representation.ModelUnitcell3D, params, { state: initialState });
        await this.plugin.updateDataState(unitcell, { revertOnError: true });
        return unitcell.selector;
    }

    async createStructure(modelRef: StateObjectRef<SO.Molecule.Model>, params?: RootStructureDefinition.Params, initialState?: Partial<StateTransform.State>) {
        const state = this.dataState;

        if (!params) {
            const model = StateObjectRef.resolveAndCheck(state, modelRef);
            if (model) {
                const symm = ModelSymmetry.Provider.get(model.obj?.data!);
                if (!symm || symm?.assemblies.length === 0) params = { name: 'deposited', params: { } };
            }
        }

        const structure = state.build().to(modelRef)
            .apply(StateTransforms.Model.StructureFromModel, { type: params || { name: 'assembly', params: { } } }, { state: initialState });

        await this.plugin.updateDataState(structure, { revertOnError: true });
        return structure.selector;
    }

    async insertStructureProperties(structure: StateObjectRef<SO.Molecule.Structure>, params?: StateTransformer.Params<StateTransforms['Model']['CustomStructureProperties']>) {
        const state = this.dataState;
        const props = state.build().to(structure)
            .apply(StateTransforms.Model.CustomStructureProperties, params);
        await this.plugin.updateDataState(props, { revertOnError: true });
        return props.selector;
    }

    isComponentTransform(cell: StateObjectCell) {
        return cell.transform.transformer === StateTransforms.Model.StructureComponent;
    }

    /** returns undefined if the component is empty/null */
    async tryCreateComponent(structure: StateObjectRef<SO.Molecule.Structure>, params: StructureComponentParams, key: string, tags?: string[]): Promise<StateObjectRef<SO.Molecule.Structure> | undefined> {
        const state = this.dataState;

        const root = state.build().to(structure);

        const keyTag = `structure-component-${key}`;
        const component = root.applyOrUpdateTagged(keyTag, StateTransforms.Model.StructureComponent, params, {
            tags: tags ? [...tags, StructureBuilderTags.Component, keyTag] : [StructureBuilderTags.Component, keyTag]
        });

        await this.plugin.updateDataState(component);

        const selector = component.selector;

        if (!selector.isOk || selector.cell?.obj?.data.elementCount === 0) {
            const del = state.build().delete(selector.ref);
            await this.plugin.updateDataState(del);
            return;
        }

        return selector;
    }

    tryCreateComponentFromExpression(structure: StateObjectRef<SO.Molecule.Structure>, expression: Expression, key: string, params?: { label?: string, tags?: string[] }) {
        return this.tryCreateComponent(structure, {
            type: { name: 'expression', params: expression },
            nullIfEmpty: true,
            label: (params?.label || '').trim()
        }, key, params?.tags);
    }

    tryCreateComponentStatic(structure: StateObjectRef<SO.Molecule.Structure>, type: StaticStructureComponentType, key: string, params?: { label?: string, tags?: string[] }) {
        return this.tryCreateComponent(structure, {
            type: { name: 'static', params: type },
            nullIfEmpty: true,
            label: (params?.label || '').trim()
        }, key, params?.tags);
    }

    tryCreateComponentFromSelection(structure: StateObjectRef<SO.Molecule.Structure>, selection: StructureSelectionQuery, key: string, params?: { label?: string, tags?: string[] }): Promise<StateObjectRef<SO.Molecule.Structure> | undefined> {
        return this.plugin.runTask(Task.create('Query Component', async taskCtx => {
            let { label, tags } = params || { };
            label = (label || '').trim();

            const structureData = StateObjectRef.resolveAndCheck(this.dataState, structure)?.obj?.data;

            if (!structureData) return;

            const transformParams: StructureComponentParams = selection.referencesCurrent
                ? {
                    type: {
                        name: 'bundle',
                        params: StructureElement.Bundle.fromSelection(await selection.getSelection(this.plugin, taskCtx, structureData)) },
                    nullIfEmpty: true,
                    label: label || selection.label
                } : {
                    type: { name: 'expression', params: selection.expression },
                    nullIfEmpty: true,
                    label: label || selection.label
                };

            if (selection.ensureCustomProperties) {
                await selection.ensureCustomProperties({ fetch: this.plugin.fetch, runtime: taskCtx }, structureData);
            }

            return this.tryCreateComponent(structure, transformParams, key, tags);
        }))
    }

    constructor(public plugin: PluginContext) {
    }
}