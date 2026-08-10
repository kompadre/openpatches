// Reusable tag editor component with autocomplete (datalist).
import { tagStore } from './patch-model.js';

export function createTagEditor(target, onUpdate) {
    const wrapper = document.createElement('div');
    wrapper.className = 'tags-container';

    function render() {
        wrapper.innerHTML = '';
        const tags = target.tags || [];

        // Chips
        tags.forEach(tag => {
            const chip = document.createElement('span');
            chip.className = 'tag-chip';
            chip.textContent = tag;

            const remove = document.createElement('span');
            remove.className = 'tag-remove';
            remove.textContent = '×';
            remove.addEventListener('click', (e) => {
                e.stopPropagation();
                target.tags = target.tags.filter(t => t !== tag);
                onUpdate(target);
                render();
            });
            chip.appendChild(remove);
            wrapper.appendChild(chip);
        });

        // Add button
        const addBtn = document.createElement('button');
        addBtn.className = 'tag-add-btn';
        addBtn.textContent = '+ Tag';
        addBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            showInput();
        });
        wrapper.appendChild(addBtn);
    }

    function showInput() {
        wrapper.innerHTML = '';
        const input = document.createElement('input');
        input.className = 'tag-input';
        input.setAttribute('list', 'global-tags-list');
        input.placeholder = 'Tag...';

        // Autocomplete setup (uses a single global datalist if possible)
        ensureGlobalDatalist();

        const commit = () => {
            const val = input.value.trim();
            if (val) {
                if (!target.tags) target.tags = [];
                if (!target.tags.includes(val)) {
                    target.tags.push(val);
                    tagStore.addTag(val);
                    onUpdate(target);
                }
            }
            render();
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') render();
        });

        input.addEventListener('blur', commit);

        wrapper.appendChild(input);
        input.focus();
    }

    render();
    return wrapper;
}

function ensureGlobalDatalist() {
    let list = document.getElementById('global-tags-list');
    if (!list) {
        list = document.createElement('datalist');
        list.id = 'global-tags-list';
        document.body.appendChild(list);
    }
    list.innerHTML = '';
    tagStore.getTags().forEach(tag => {
        const opt = document.createElement('option');
        opt.value = tag;
        list.appendChild(opt);
    });
}
